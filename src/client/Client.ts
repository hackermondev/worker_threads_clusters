import { WorkerOptions } from './node/Worker';
import NodeClient from './node/NodeClient';
import getAuth from '../helpers/getAuth';
import { ServerAuth } from '../server/Server';

/**
 * @public
 */
export interface ClientOptions { 
	/**
	 * Default worker options
	 * All works spawned are given this options
	 */
	defaultWorkerOptions?: WorkerOptions, 

	/**
	 * The behavior when choosing what node a worker should be created on
	 * random -  pick a random node
	 * incremental - use the nodes in order, first worker on first node, 2nd worker on 2nd node, etc and it keeps resetting back to first worker and continues the cycle
	 * balancing - it will fetch the cpu(s) usage of all the nodes and choose the best one to spawn the worker based on the usage percentage 
	 */
	choicesBehavior: 'random' | 'incremental' | 'balancing' 
}

/**
 * @public
 */
export type NodeOption = string | { 
	/**
	 * Base URL of node
	 */
	baseURL: string, 

	/**
	 * Authentication details of node
	 */
	auth: ServerAuth 
};


/**
 * Base class for clients
 * 
 * @public
 */
export default class Client {
	private _options: ClientOptions;
	private _lastIndex: number;

	/**
	 * Array of nodes the client is connected to
	 */
	public nodes: NodeClient[];

	/**
	 * Create a new client
	 * @param options - Client options
	 */
	constructor(options: ClientOptions) {
		this._options = options;
		this._lastIndex = -1;
		this.nodes = [];
	}

	/**
	 * Alternative of `cluster.fork` 
	 * Spawns a new worker which is just running the current file
	 * 
	 * @example
	 * ```js
	 * const cluster = require('node:cluster');
	 * const process = require('node:process');
	 * const { Client } = require('worker_threads_cluster');
	 * 
	 * const client = new Client();
	 * 
	 * 
	 * // add your nodes here
	 * client.addNode(...)
	 * client.addNode(...)
	 * client.addNode(...)
	 * 
	 * 
	 * 
	 * 
	 * if (cluster.isPrimary) {
	 * 		console.log(`Primary ${process.pid} is running`);
	 * 
	 * 		// Fork workers.
	 * 		for (let i = 0; i < 10; i++) {
	 *			client.fork();
	 *		}
	 *	} else {
	 *		console.log("Hey! I'm a fork!")
	 *	}
	 * ```
	 * 
	 * @param options - Extra worker options
	 * @returns Worker
	 */
	async fork(options?: WorkerOptions) {
		return this.spawnWorker(__filename, options);
	}



	/**
	 * Create a new worker
	 * 
	 * @example
	 * ```js
	 * const { Client } = require('worker_threads_cluster');
	 * 
	 * const client = new Client();
	 * 
	 * 
	 * // add your nodes here
	 * client.addNode(...)
	 * client.addNode(...)
	 * client.addNode(...)
	 * 
	 * 
	 * 
	 * 
	 * (async ()=>{
	 * 		// test.js is automatically bundled and uploaded to the node (thanks ESBuild)
	 * 		const worker = await client.spawnWorker('test.js');
	 * 		worker.on('online', () => console.log('connected'))
	 * })()
	 * ```
	 * 
	 * @param file - Path to file to run on worker
	 * @param options - Extra worker options
	 * @remarks The file path should be an absolute path to the file location 
	 * @returns Worker
	 */
	async spawnWorker(file: string, options?: WorkerOptions) {
		const node = await this._findNodeToUse();
		options = { ...this._options.defaultWorkerOptions, ...options };

		options.env = {
			...process.env,
			...options.env,
		};

		options.execArgv = options.execArgv || process.execArgv;
		const worker = await node.launchWorker(file, options);
		return worker;
	}

	private async _findNodeToUse(): Promise<NodeClient> {
		if(this.nodes.length < 1) throw new Error('no available nodes');
		let node: NodeClient = this.nodes[0];

		switch(this._options.choicesBehavior) {
		case 'random':
			// eslint-disable-next-line no-case-declarations
			const index = Math.floor(Math.random()* this.nodes.length)
			node = this.nodes[index];

			break;

		case 'incremental':
			// eslint-disable-next-line no-case-declarations
			let newIndex = this._lastIndex + 1;
			if(!this.nodes[newIndex]) newIndex = 0;
			
			node = this.nodes[newIndex];
			this._lastIndex = newIndex;
			break;

		case 'balancing':
			// eslint-disable-next-line no-case-declarations
			const readyNodes = this.nodes.filter((n) => n.usage != null);

			if(readyNodes.length < 1) break

			// eslint-disable-next-line no-case-declarations
			const sorted = readyNodes.sort((a, b) => {
				if(!a.usage || !b.usage) return 0;
				
				const averageCPUUsageA = a.usage.cpuUsage.reduce((a, b) => a + b) / a.usage.cpuUsage.length;
				const averageCPUUsageB = b.usage.cpuUsage.reduce((a, b) => a + b) / b.usage.cpuUsage.length;

				if(averageCPUUsageA > averageCPUUsageB) return -1;
				if(averageCPUUsageB > averageCPUUsageA) return 1;

				return 0;
			});


			// eslint-disable-next-line no-case-declarations
			let newIndex_ = this._lastIndex + 1;
			if(!sorted[newIndex_]) newIndex_ = 0;
			
			node = sorted[newIndex_];
			this._lastIndex = newIndex_;
			break;
		}

		return node;
	}


	/**
	 * Add a new node to the node array
	 * 
	 * @example
	 * ```js
	 * const { Client } = require('worker_threads_cluster');
	 * 
	 * const client = new Client();
	 * 
	 * 
	 * client.addNode('http://username:password@node1.cluster.local');
	 * client.addNode('http://username:password@node2.cluster.local', 'http://username:password@node3.cluster.local')
	 * client.addNode({
	 * 		baseURL: 'http://node4.cluster.local',
	 * 		auth: {
	 * 			username: 'username',
	 * 			password: 'password'
	 * 		}
	 * })
	 * ```
	 * 
	 * @param nodes - nodes
	 * @remarks All nodes should contain auth
	 */
	addNode(...nodes: NodeOption[]) {
		for(let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			if(typeof n == 'string') {
				const url = new URL(n);
				const auth = getAuth(n);

				this.nodes.push(new NodeClient(url.origin, auth));
			} else {
				this.nodes.push(new NodeClient(n.baseURL, n.auth));
			}
		}
	}
}