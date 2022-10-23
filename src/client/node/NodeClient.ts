import axios, { AxiosInstance, AxiosResponse } from 'axios';
import esbuild from 'esbuild';
import { randomUUID } from 'crypto';

import { tmpdir } from 'os';
import { join } from 'path';

import { ServerAuth } from '../../server/Server';
import calculateFileHash from '../../helpers/sha256';
import { createReadStream, rmSync } from 'fs';
import Worker, { WorkerOptions } from './Worker';

export interface NodeUsage {
	workersRunning: number
	cpuUsage: number[]
}

/**
 * @internal
 */
export default class NodeClient {
	public name: string | null;
	public version: string | null;
	public usage: NodeUsage | null;
	public nodeVersion: string | null;

	public _auth: ServerAuth;
	public _baseHost: string;
	public _interval: NodeJS.Timer | null;
	public workers: Worker[];
	public http: AxiosInstance;

	constructor(baseHost: string, auth: ServerAuth ) {
		this._baseHost = baseHost;
		this.workers = [];

		this.name = null;
		this.version = null;
		this.nodeVersion = null;
		this.usage = null;

		this.http = axios.create({  baseURL: this._baseHost, auth, timeout: 0 });
		this._auth = auth;
		this.fetchInformation();

		this._interval = null;
	}

	private async _testConnection(): Promise<boolean> {
		const request = await this.http.get('/').catch(() => false);
		return request != false
	}

	private async fetchInformation(onlyFetchUsage=false) {
		const nodeIsOnline = await this._testConnection();
		if(!nodeIsOnline) return;

		if(onlyFetchUsage != true) {
			const request = await this.http.get('/');

			this.name = request.data['name'];
			this.nodeVersion = request.data['nodeVersion'];
			this.version = request.headers['server']?.split('/')[1] || null;

			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const packageVersion = require('../../../package.json').version;
			if(packageVersion != this.version) console.warn(`[warning] Worker[${this.name}]: current package version is ${packageVersion} but node version is ${this.version}, this may cause issues`);
		}

		const request2: AxiosResponse<NodeUsage> = await this.http.get('/health');
		this.usage = request2.data;	
	}

	async launchWorker(path: string, options: WorkerOptions) {
		const hash = await this.bundle(path);
		const worker = new Worker(this, hash, options);

		if(this._interval == null) this._interval = setInterval(() => this.fetchInformation(true), 10_000);
		return worker;
	}

	// Creates bundle for file
	// Check if hash already exists in node
	// If not, upload bundle to node
	private async bundle(filePath: string) {
		const nodeIsOnline = await this._testConnection();
		if(!nodeIsOnline) throw new Error('Could not connect to node. Please verify that the server is running.');

		if(!this.nodeVersion) await this.fetchInformation();

		const outFile = join(tmpdir(), `${randomUUID()}.js`);
		await esbuild.build({ 
			outfile: outFile, 
			bundle: true, 
			platform: 'node', 
			entryPoints: [filePath], 
			minify: true, 
			target: `node${this.nodeVersion}`, 
			keepNames: true,
			sourcemap: 'inline'
		});

		const hash = await calculateFileHash(outFile);
		const exists = await this.http.get(`/bundles/${hash}`).catch(() => false);
		if(!exists) {
			await this.http.post('/bundles/create', { hash });	
			await this.http.post(`/bundles/${hash}/data?compression=none`, createReadStream(outFile), {
				headers: {
					'Content-Type': 'application/octet-stream'
				}
			}); // TODO: compress big files
		}

		rmSync(outFile);
		return hash;
	}
}