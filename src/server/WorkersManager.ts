import { join } from 'path';
import { blue, green, red } from 'chalk';

import { Worker } from 'worker_threads';
import { Express, Request, Response } from 'express';
import BundlesManager from './BundlesManager';
import { randomUUID } from 'node:crypto';
import Server from './Server';


declare module 'worker_threads' {
    interface Worker {
        id?: string;
		isOnline: boolean;
		numOfConnectedSockets: number;
    }
}

/**
 * @internal
 */
export default class WorkersManager {
	private server: Server;
	private _http: Express;
	private bundlesManager: BundlesManager;
	public workers: Worker[];

	constructor(server: Server, bundlesManager: BundlesManager) {
		this.server = server;
		this._http = server._http;
		this.workers = [];

		this.bundlesManager = bundlesManager;

		this._http.get('/workers', (_, res) => res.json(this.workers.map((w) => w.id)));
		this._http.post('/worker', async (req, res) => {
			const { bundleHash, extraData, exitOnRequestEnd } = req.body;
			if(!this.bundlesManager.cachedBundledHashes.includes(bundleHash)) return res.status(400).end();

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
	}


	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private createWorker(bundleHash: string, extra: any): Worker {
		const file = join(this.bundlesManager.tmpDir, `${bundleHash}.js`);
		const id = randomUUID();

		this.server._log('[worker-manager] creating worker from bundle', blue(bundleHash), '(worker id =', green(id), ')');
		const worker = new Worker(file, {
			...extra,

			eval: false,
			stdout: true,
			stderr: true,
		});

		worker.id = id;
		worker.isOnline = false;
		worker.numOfConnectedSockets = 0;

		const onExit = () => {
			const index = this.workers.findIndex((w) => w.id == id);
			this.workers.splice(index, 1);

			this.server._log('[worker-manager] worker', green(id), 'hash exited.');
		};

		worker.once('online', () => {
			worker.isOnline = true;
			this.server._log('[worker-manager] worker', green(id), 'is online');
		});

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
				this.server._log('[worker-manager] sent', red(`${decoded.length} bytes`), 'of data to worker', green(worker.id));
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

		const exit = () => res.end();

		worker.once('exit', exit);
		worker.once('error', exit);
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
			res.end(`exit: ${exitCode}\n`);
		};

		const error = (err: Error) => {
			res.end(`error: ${Buffer.from(JSON.stringify({
				name: err.name,
				message: err.message,
				stack: err.stack
			})).toString('base64')}\n`);
		};

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const message = (data: any) => {
			res.write(`message: ${Buffer.from(data).toString('base64')}\n`);
		};

		const online = () => res.write('online: true\n');
		res.write(`online: ${worker.isOnline}\n`);

		worker.numOfConnectedSockets += 1;
		this.server._log('[worker-manager] new read stream socket to worker', green(worker.id), 'was created');

		if(!worker.isOnline) worker.once('online', online);
		worker.stdout.on('data', stdout);
		worker.stderr.on('data', stderr);

		worker.once('exit', exit);
		worker.on('error', error);
		worker.on('message', message);


		// When connection is closed, remove listeners
		res.once('close', () => {
			worker.numOfConnectedSockets -= 1;
			this.server._log('[worker-manager] read stream socket to worker', green(worker.id), 'was closed');

			if(exitOnRequestEnd && worker.numOfConnectedSockets == 0) {
				// Close worker in 5 seconds if the connection is reconnected.
				setTimeout(()=>{
					if(worker.numOfConnectedSockets == 0) {
						this.server._log('[worker-manager] terminating worker', green(worker.id), 'because no more connected read streams (all clients disconnected)');
						worker.terminate();
					}
				}, 1_000);
			}

			
			worker.stdout.removeListener('data', stdout);
			worker.stderr.removeListener('data', stderr);
			worker.removeListener('exit', exit);
			worker.removeListener('error', error);
			worker.removeListener('message', message);
			worker.removeListener('online', online);
				
			res.end();
		});
	}
}