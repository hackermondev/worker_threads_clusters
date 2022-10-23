/* eslint-disable no-case-declarations */
import { EventEmitter, PassThrough } from 'stream';
import NodeClient from './NodeClient';
import getHTTPClient from '../../helpers/getHTTPClient';
import { ClientRequest } from 'http';


export interface WorkerOptions { 
	argv?: unknown[]
	env?: Record<string, unknown>
	execArgv?: string[]
	workerData?: unknown
	transferList?: Record<string, unknown>[]
	stdin?: boolean
	pipeToProcess?: boolean
	resourceLimits?: {
		maxOldGenerationSizeMb: number
		maxYoungGenerationSizeMb: number
		codeRangeSizeMb: number
		stackSizeMb: number
	}
}

export default class Worker extends EventEmitter {
	public id: string | null;
	private _node: NodeClient;
	private _hash: string;
	private _pipes: PassThrough[];

	public options: WorkerOptions;
	public isLaunched: boolean;

	public stdout: PassThrough;
	public stderr: PassThrough;
	public stdin: PassThrough;

	constructor(node: NodeClient, hash: string, options: WorkerOptions, reconnectionOptions?: { id: string }) {
		super();

		this.id = null;
		this._hash = hash;
		this._node = node;

		this.isLaunched = false;
		this.options = options;
		this._pipes = [
			new PassThrough(), // stream where stdout, stderr and worker messages are piped
			new PassThrough() // stream where stdin is piped from
		];

		this.stdin = new PassThrough();
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();

		this.processReadPipes();
		this.stdin.on('data', (chunk) => {
			const encoded = Buffer.from(chunk).toString('base64');
			this._pipes[1].write(`stdin: ${encoded}\n`);

			if(!this.options.stdin) console.warn(`[warning] Worker[${this._node.name}]: stdin was written to but "stdin" option is not enabled so it will not be passed to worker`)
		});


		if(reconnectionOptions) this.id = reconnectionOptions.id;

		if(this.options.pipeToProcess != false) {
			this.stdout.pipe(process.stdout);
			this.stderr.pipe(process.stderr);
		}

		this._connect();
	}

	private processReadPipes() {
		const onMessage = (data: string) => {
			// messages are usually like 'messagename: messagevalue'
			const chunks = data.split(':');

			const name = chunks[0];
			const value = chunks[1].trimStart();

			switch(name) {
			case 'online':
				if(value == 'true') this.emit('online');
				break
			
			case 'error':
				const data = JSON.parse(Buffer.from(value, 'base64').toString());
				const error = new Error(data.stack);
				
				this.emit('error', error);
				const listener = this.rawListeners('error');
				if(listener.length < 1) throw error;

				break
			
			case 'exit':
				const code = parseInt(value);
				this.emit('exit', code);
				this.isLaunched = false;
				break

			case 'stdout':
				const stdoutdecoded = Buffer.from(value, 'base64').toString();
				this.stdout.write(stdoutdecoded);
				break

			case 'stderr':
				const stderrdecoded = Buffer.from(value, 'base64').toString();
				this.stderr.write(stderrdecoded);
				break

			case 'message':
				const messagedecoded = Buffer.from(value, 'base64').toString();
				this.emit('message', messagedecoded);
			}
		};

		// super weird and complicated parser 
		// it basically just tries to correctly split recieved chunks by '\n'
		// "message: a\nmessage2: a\n" -> ["message: a", "message2: a"]
		// "message: a", "\nmessage2: a\n" -> ["message: a", "message2: a"]
		let buffer = '';
		this._pipes[0].on('data', (chunk) => {
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

	async postMessage(value: never) {
		const encoded = Buffer.from(value).toString('base64');
		this._pipes[1].write(`worker_message: ${encoded}\n`);	
	}

	terminate() {
		return new Promise((resolve) => {
			this._pipes[1].write('terminate: true\n');

			this.once('exit', () => {
				resolve(true);
			});
		});
	}


	async _connect() {
		if(this.isLaunched) throw new Error('Worker is already launched');
		let workerID = this.id;

		if(!this.id) {
			const response = await this._node.http.post('/worker', {
				bundleHash: this._hash,
				extraData: this.options,
				exitOnRequestEnd: true,
			}, { responseType: 'stream' });
			
			response.data.pipe(this._pipes[0]);			
			if(response.headers['x-worker-id']) workerID = response.headers['x-worker-id'];
		} else {
			const response = await this._node.http.get(`/worker/${this.id}/streams-pipe`, { responseType: 'stream' });
			response.data.pipe(this._pipes[0]);
		}


		this.id = workerID;
		
		// Write stream
		// We use node's builtin HTTP instead of axios here because axios is fucking stupid and cannot work properly with event streams
		const http = getHTTPClient(this._node._baseHost);

		let rs: ClientRequest | null = null;
		let manuallyClosed = false;
		
		const startWriteStream = () => {
			rs = http.request(`${this._node._baseHost}/worker/${workerID}/streams-pipe`, {
				method: 'POST',
				auth: `${this._node._auth.username}:${this._node._auth.password}`,
				timeout: 0
			});
	
			this._pipes[1].pipe(rs);
			this.isLaunched = true;

			rs.on('response', (response) => {
				if(response.statusCode == 404) manuallyClosed = true
			});

			rs.on('close', () => {
				if(manuallyClosed) return;

				// If disconnect, restart write stream
				startWriteStream();
			});
		};

		startWriteStream();
		const exit = () => {
			manuallyClosed = true
			rs?.end();

			// Remove itself from the workers array in the node class
			const index = this._node.workers.findIndex((w) => w.id == this.id);
			this._node.workers.splice(index, 1);

			if(this._node.workers.length == 0 && this._node._interval != null) {
				clearInterval(this._node._interval);
				this._node._interval = null;
			}
		};

		this.once('exit', () => exit());
		this.once('error', () => exit());
	}
}