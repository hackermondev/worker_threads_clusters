/* eslint-disable no-case-declarations */
import { EventEmitter, PassThrough } from 'stream';
import axios from 'axios';
import NodeClient from './NodeClient';
import getHTTPClient from '../../helpers/getHTTPClient';
import { ClientRequest } from 'http';



const workedExitError = new Error('Worker has exited.');

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
//@ts-ignore
workedExitError.code = 'ERR_WORKER_EXITED';

/**
 * @public
 */
export interface WorkerOptions { 
	/**
	 * List of arguments which would be stringified and appended to process.argv in the worker. This is mostly similar to the workerData but the values are available on the global process.argv as if they were passed as CLI options to the script.
	 */
	argv?: unknown[]


	/**
	 * Object of envs to pass to the worker
	 */
	env?: Record<string, unknown>
	
	/**
	 *  List of node CLI options passed to the worker. V8 options (such as --max-old-space-size) and options that affect the process (such as --title) are not supported. If set, this is provided as process.execArgv inside the worker. By default, options are inherited from the parent thread.
	 */
	execArgv?: string[]

	/**
	 * Worker data to pass to the worker
	 */
	workerData?: unknown

	/**
	 * https://nodejs.org/api/worker_threads.html#new-workerfilename-options
	 */
	transferList?: Record<string, unknown>[]

	/**
	 * Whether or not stdin should be created for the worker
	 * @defaultValue false
	 */
	stdin?: boolean

	/**
	 * Whether or not it should pipe `worker.stdout` and `worker.stderr` to `process.stdout` and `process.stderr`
	 * @defaultValue true
	 */
	pipeToProcess?: boolean

	/**
	 * https://nodejs.org/api/worker_threads.html#workerresourcelimits
	 */
	resourceLimits?: {
		/**
		 * https://nodejs.org/api/worker_threads.html#workerresourcelimits
		 */
		maxOldGenerationSizeMb: number
		
		/**
		 * https://nodejs.org/api/worker_threads.html#workerresourcelimits
		 */
		maxYoungGenerationSizeMb: number

		/**
		 * https://nodejs.org/api/worker_threads.html#workerresourcelimits
		 */
		codeRangeSizeMb: number

		/**
		 * https://nodejs.org/api/worker_threads.html#workerresourcelimits
		 */
		stackSizeMb: number
	}
}

/**
 * @public
 */
export default class Worker extends EventEmitter {
	public id: string | null;
	private _node: NodeClient;
	private _hash: string;
	private _pipes: PassThrough[];

	public exitCode: number | null;
	public options: WorkerOptions;
	public isLaunched: boolean;

	public stdout: PassThrough;
	public stderr: PassThrough;
	public stdin: PassThrough;

	constructor(node: NodeClient, hash: string, options: WorkerOptions, reconnectionOptions?: { id: string }) {
		super();

		this.id = null;
		this.exitCode = null;
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
			if(this.exitCode) throw workedExitError;
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

	private _handleError(error: Error) {
		this.emit('error', error);
		this.exitCode = 1;

		const listener = this.rawListeners('error');
		if(listener.length < 1) throw error;

		return error;
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
				this._handleError(error);

				break
			
			case 'exit':
				const code = parseInt(value);
				this.isLaunched = false;
				this.exitCode = code;

				this.emit('exit', code);
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
		if(this.exitCode) throw workedExitError;

		const encoded = Buffer.from(value).toString('base64');
		this._pipes[1].write(`worker_message: ${encoded}\n`);	
	}

	terminate() {
		return new Promise((resolve, reject) => {
			if(this.exitCode) return reject(workedExitError);
			this._pipes[1].write('terminate: true\n');

			this.once('exit', () => {
				resolve(true);
			});
		});
	}


	async _connect() {
		if(this.isLaunched) throw new Error('Worker is already launched');

		this.exitCode = null;
		let workerID = this.id;

		if(!this.id) {
			const response = await this._node.http.post('/worker', {
				bundleHash: this._hash,
				extraData: this.options,
				exitOnRequestEnd: true,
			}, { responseType: 'stream' }).catch((err) => err);
			
			if(response instanceof Error || axios.isAxiosError(response)) {
				return this._handleError(response);
			}

			response.data.pipe(this._pipes[0]);

			const request: ClientRequest = response.request;
			request.socket?.on('close', () => {
				if(this.exitCode) return;

				// disconnected
				const err = new Error('Worker connection was disconnected.');

				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				//@ts-ignore
				err.code = 'ERRWORKERDISCONNECTED';

				this._handleError(err)
			});

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
			//make sure previous connection is closed
			if(rs) rs.end();

			rs = http.request(`${this._node._baseHost}/worker/${workerID}/streams-pipe`, {
				method: 'POST',
				auth: `${this._node._auth.username}:${this._node._auth.password}`,
				timeout: 0
			});
			
			rs.on('error', (err) => {
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				//@ts-ignore
				if(err.code == 'ECONNREFUSED') return;
				throw err;
			});

			this._pipes[1].pipe(rs);
			this.isLaunched = true;

			rs.on('response', (response) => {
				if(response.statusCode == 404) manuallyClosed = true
			});

			rs.on('close', () => {
				if(manuallyClosed || this.exitCode) return;

				// If disconnect, restart write stream
				startWriteStream();
			});
		};

		startWriteStream();
		const exit = () => {
			manuallyClosed = true

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
		return true;
	}
}