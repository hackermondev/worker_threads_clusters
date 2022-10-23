import express, { Express, NextFunction, Request, Response } from 'express';
import { bold, green } from 'chalk';
import bodyParser from 'body-parser';

import { hostname } from 'os';
import getCPUUsage from '../helpers/cpu';

import BundlesManager from './BundlesManager';
import WorkersManager from './WorkersManager';

export interface ServerAuth {
    username: string;
    password: string;
}



/**
 * Base class for server
 * @public
 */
export default class Server {
	public name: string;
	public _http: Express;

	private _port: number;
	private logging: boolean;
	private auth: ServerAuth;
	
	private bundles: BundlesManager;
	private workersManager: WorkersManager;

	constructor({ name, auth, port, log }: { name?: string, auth: ServerAuth, port: number, log?: boolean }) {
		this._http = express();

		log = log || true;
		this.name = name || hostname();
		this._port = port;
		this.auth = auth;
		
		// Register routes & middlewares
		this._http.disable('x-powered-by');
		this._http.use(bodyParser.json());
		this._http.use(bodyParser.raw({ type: ['application/octet-stream'], limit: '1GB' }));

		this._http.use(this._authMiddleware.bind(this));

		this.logging = log;
		this.bundles = new BundlesManager(this);
		this.workersManager = new WorkersManager(this, this.bundles);

		this._http.get('/', (_, res) => res.json({ name: this.name, nodeVersion: process.versions.node }));
		this._http.get('/health', async (_, res) => 
			res.json({
				workersRunning: this.workersManager.workers.length,
				cpuUsage: await getCPUUsage(),
			})
		);	
	}

	public _log(...data: unknown[]) {
		if(!this.logging) return;
		console.log(bold(...data))
	}

	public start(): Promise<void> {
		return new Promise((resolve) => {
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			//@ts-ignore
			const server = this._http.listen(this._port, () => {
				this._log('[http-server] started http server');
				resolve();
			});

			server.setTimeout(0);
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

		this._log('[http-server] http connection from', green(request.ip), 'was rejected because of invalid auth');
		response.set('WWW-Authenticate', 'Basic realm="worker_threads_nodes"');
		response.status(401);
		response.send('Authorization required to continue.');
	}
}
