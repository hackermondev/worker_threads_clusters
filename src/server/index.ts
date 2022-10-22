import express, { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { getCPUUsage } from '../helpers/cpu';
import type { ServerAuth } from './types';
import { randomUUID } from 'crypto';

declare module 'worker_threads' {
    interface Worker {
        id?: string;
		isOnline: boolean;
    }
}

export default class Server {
	public name: string;
	public _http: Express;
	public workers: Worker[];

	private _port: number;
	private auth: ServerAuth;
	private cachedBundledHashes: string[];
	private tmpDir: string;

	constructor({ name, auth, port }: { name?: string, auth: ServerAuth, port: number }) {
		this.workers = [];
		this.tmpDir = join(tmpdir(), 'workers-nodes-bundled');

		this.cachedBundledHashes = this.getCachedBundledHashes();
		this._http = express();

		this.name = name || hostname();
		this._port = port;
		this.auth = auth;
		
		// Register routes & middlewares
		this._http.disable('x-powered-by');
		this._http.use(cors({ origin: '*', preflightContinue: false }));
		this._http.use(this._authMiddleware.bind(this));

		this._http.use(bodyParser.json());
		this._http.use(bodyParser.raw({ type: ['application/octet-stream'], limit: '1GB' }));

		this._http.get('/', (_, res) => res.json({ name: this.name, cachedBundledHashes: this.cachedBundledHashes }));
		this._http.get('/health', async (_, res) => 
			res.json({
				workersRunning: this.workers.length,
				cpuUsage: await getCPUUsage(),
			})
		);


		this._http.get('/workers', (_, res) => res.json(this.workers.map((w) => w.id)));
		this._http.post('/worker', async (req, res) => {
			const { bundleHash, extraData, exitOnRequestEnd } = req.body;
			if(!this.cachedBundledHashes.includes(bundleHash)) return res.status(400).end();

			const w = this.createWorker(bundleHash, extraData);

			res.status(200);
			res.set('x-worker-id', w.id);

			this.pipeWorkerReadStreams(w, res, exitOnRequestEnd == true);
			return 1;
		});

		this._http.get('/worker/:id/streams-pipe', (req, res) => {
			const worker = this.workers.find((w) => w.id == req.params.id);
			if(!worker) return res.status(404).end();

			res.status(200);
			this.pipeWorkerReadStreams(worker, res, req.query['exitOnRequestEnd'] != undefined);
			return 1;
		});

		this._http.post('/worker/:id/streams-pipe', (req, res) => {
			const worker = this.workers.find((w) => w.id == req.params.id);
			if(!worker) return res.status(404).end();

			res.status(200);
			this.pipeWorkerWriteStreams(worker, req, res);
			return 1;
		});
	
		
		


		this._http.post('/bundles/create', async (req, res) => {
			const { hash } = req.body;
			const file = join(this.tmpDir, `${hash}.js`);

			writeFileSync(file, '');
			this.cachedBundledHashes.push(hash);

			res.status(201).end();
		});

		this._http.get('/bundles/:hash', async (req, res) => {
			if(!this.cachedBundledHashes.includes(req.params.hash)) return res.status(404).end();

			const file = join(this.tmpDir, `${req.params.hash}.js`);
			const stat = statSync(file);

			return res.json({
				hash: req.params.hash,
				size: stat.size,
				created: stat.birthtime.toLocaleString('UTC')
			})
		});

		this._http.post('/bundles/:hash/data', async (req, res) => {
			if(!this.cachedBundledHashes.includes(req.params.hash)) return res.status(404).end();
			if(!Buffer.isBuffer(req.body)) return res.status(400).end();

			const file = join(this.tmpDir, `${req.params.hash}.js`);

			const compression = req.query['compression'] || 'none';
			const data = req.body;

			
			if(compression == 'none') {
				writeFileSync(file, data);
			}

			return res.status(204).end();
		});
	}


	public clearAllCachedBundles() {
		rmdirSync(this.tmpDir);
		mkdirSync(this.tmpDir);

		this.cachedBundledHashes = [];
	}
	
	public start(): Promise<void> {
		return new Promise((resolve) => 
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			//@ts-ignore
			this._http.listen(this._port, resolve)
		);	
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private createWorker(bundleHash: string, extra: any): Worker {
		const file = join(this.tmpDir, `${bundleHash}.js`);
		const id = randomUUID();

		const worker = new Worker(file, {
			...extra,

			eval: false,
			stdout: true,
			stderr: true,
		});

		worker.id = id;
		worker.isOnline = false;

		const onExit = () => {
			const index = this.workers.findIndex((w) => w.id == id);
			this.workers.splice(index, 1);
		};

		worker.once('online', () => worker.isOnline = true);
		worker.on('error', onExit);
		worker.on('exit', onExit);

		this.workers.push(worker);
		return worker;
	}

	private pipeWorkerWriteStreams(worker: Worker, req: Request, res: Response) {
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Connection', 'keep-alive');
		res.flushHeaders(); // flush the headers to establish SSE with client

		const onMessage = (data: string) => {
			// messages are usually like 'messagename: messagevalue'
			const chunks = data.split(':');

			const name = chunks[0];
			const value = chunks[1].trimStart();

			const decoded = Buffer.from(value, 'base64').toString();
			switch(name) {
			case 'stdin':
				worker.stdin?.write(decoded);
				break
			
			case 'worker_message':
				worker.postMessage(decoded);
				break
			
			case 'terminate':
				worker.terminate();
				break
			}
		};

		// super weird and complicated parser 
		// it basically just tries to correctly split recieved chunks by '\n'
		// "message: a\nmessage2: a\n" -> ["message: a", "message2: a"]
		// "message: a", "\nmessage2: a\n" -> ["message: a", "message2: a"]

		let buffer = '';
		req.on('data', (chunk) => {
			const m = Buffer.from(chunk).toString().split('\n');
			buffer += m[0];

			m.shift();
			if(m.length > 0) {
				for(let x = 0; x < m.length; x++) {
					const c = m[x];

					onMessage(buffer);
					buffer = '';

					buffer += c;
				}
			}
		});
	}

	private pipeWorkerReadStreams(worker: Worker, res: Response, exitOnRequestEnd=false) {
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Connection', 'keep-alive');
		res.flushHeaders(); // flush the headers to establish SSE with client

		const stderr = (chunk: Buffer | string) => {
			res.write(`stderr: ${Buffer.from(chunk).toString('base64')}\n`);
		};

		const stdout = (chunk: Buffer | string) => {
			res.write(`stdout: ${Buffer.from(chunk).toString('base64')}\n`);
		};

		const exit = (exitCode: number) => {
			res.end(`exit: ${exitCode}`);
		};

		const error = (err: Error) => {
			res.end(`error: ${JSON.stringify({
				name: err.name,
				message: err.message,
				stack: err.stack
			})}`);
		};

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const message = (data: any) => {
			res.end(`message: ${Buffer.from(data).toString('base64')}`);
		};

		const online = () => res.write('online: true\n');
		res.write(`online: ${worker.isOnline}\n`);

		if(!worker.isOnline) worker.once('online', online);
		worker.stdout.on('data', stdout);
		worker.stderr.on('data', stderr);

		worker.once('exit', exit);
		worker.on('error', error);
		worker.on('message', message);


		// When connection is closed, remove listeners
		res.once('close', () => {
			if(exitOnRequestEnd) worker.terminate();

			worker.stdout.removeListener('data', stdout);
			worker.stderr.removeListener('data', stderr);
			worker.removeListener('exit', exit);
			worker.removeListener('error', error);
			worker.removeListener('message', message);
			worker.removeListener('online', online);
				
			res.end();
		});
	}



	private getCachedBundledHashes() {
		const tempDirectory = this.tmpDir;
		if(!existsSync(tempDirectory)) mkdirSync(tempDirectory);

		const files = readdirSync(tempDirectory);
		const hashes = files.map((f) => f.split('.')[0]);
		return hashes;
	}

	private _authMiddleware(request: Request, response: Response, next: NextFunction) {
		response.set('Access-Control-Allow-Origin', '*');
		response.set('server', 
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			`worker_threads_nodes/${require('../../package.json').version}`);

		const rawAuthorization = request.headers.authorization;

		const type = rawAuthorization?.split(' ')[0];
		const authorization = rawAuthorization?.split(' ')[1];

		if(type && type.toLowerCase() == 'basic' && authorization) {
			const decodedAuth = Buffer.from(authorization, 'base64').toString();
			
			const username = decodedAuth.split(':')[0];
			const password = decodedAuth.split(':')[1];

			if(this.auth.username == username && this.auth.password == password) return next();
		}

		response.status(401);
		response.set('WWW-Authenticate', 'Basic realm="worker_threads_nodes"');
		response.send('Authorization required to continue.');

		next();
	}
}
