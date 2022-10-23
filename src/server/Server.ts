import express, { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import { hostname } from 'os';
import getCPUUsage from '../helpers/cpu';

import BundlesManager from './BundlesManager';
import WorkersManager from './WorkersManager';

declare module 'worker_threads' {
    interface Worker {
        id?: string;
		isOnline: boolean;
    }
}


export interface ServerAuth {
    username: string;
    password: string;
}

export default class Server {
	public name: string;
	public _http: Express;

	private _port: number;
	private auth: ServerAuth;
	
	private bundles: BundlesManager;
	private workersManager: WorkersManager;

	constructor({ name, auth, port }: { name?: string, auth: ServerAuth, port: number }) {
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

		this.bundles = new BundlesManager(this._http);
		this.workersManager = new WorkersManager(this._http, this.bundles);

		this._http.get('/', (_, res) => res.json({ name: this.name, nodeVersion: process.versions.node }));
		this._http.get('/health', async (_, res) => 
			res.json({
				workersRunning: this.workersManager.workers.length,
				cpuUsage: await getCPUUsage(),
			})
		);	
	}
	
	public start(): Promise<void> {
		return new Promise((resolve) => {
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			//@ts-ignore
			const server = this._http.listen(this._port, resolve);
			server.setTimeout(0);

			this.bundles.clearAllCachedBundles();
		});	
	}
	

	private _authMiddleware(request: Request, response: Response, next: NextFunction) {
		response.set('Access-Control-Allow-Origin', '*');
		response.set('server', 
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			`worker_threads_nodes/${require('../../package.json').version}`);

		request.setTimeout(0);
		request.connection.setTimeout(0);

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
