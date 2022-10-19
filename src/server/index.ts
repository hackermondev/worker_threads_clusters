import express, { Express, NextFunction, Request, Response } from 'express';
import bodyParser from 'body-parser';

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { getCPUUsage } from '../helpers/cpu';
import type { ServerAuth } from './types';


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
		this._http.use(this._authMiddleware.bind(this));
		this._http.use(bodyParser.json());
		this._http.use(bodyParser.raw({ type: ['application/octet-stream'], limit: '1GB' }));

		this._http.get('/', (_, res) => res.json({ name: this.name, cachedBundledHashes: this.cachedBundledHashes }));
		this._http.get('/health', async (_, res) => 
			res.json({
				running: this.workers.length,
				cpuUsage: await getCPUUsage(),
			})
		);

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

			return res.status(201).end();
		});
	}

	public start(): Promise<void> {
		return new Promise((resolve) => 
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			//@ts-ignore
			this._http.listen(this._port, resolve)
		);	
	}


	private getCachedBundledHashes() {
		const tempDirectory = this.tmpDir;
		if(!existsSync(tempDirectory)) mkdirSync(tempDirectory);

		const files = readdirSync(tempDirectory);
		const hashes = files.map((f) => f.split('.')[0]);
		return hashes;
	}

	private _authMiddleware(request: Request, response: Response, next: NextFunction) {
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
