import { WorkerOptions } from './node/Worker';
import NodeClient from './node/NodeClient';
import getAuth from '../helpers/getAuth';
import { ServerAuth } from '../server/Server';

export interface ClientOptions { defaultWorkerOptions?: WorkerOptions, choicesBehavior: 'random' | 'incremental' | 'balancing' }
export type NodeOption = string | { baseURL: string, auth: ServerAuth };

export default class Client {
	private _options: ClientOptions;
	private _lastIndex: number;

	public nodes: NodeClient[];

	constructor(options: ClientOptions) {
		this._options = options;
		this._lastIndex = -1;
		this.nodes = [];
	}

	async fork(options?: WorkerOptions) {
		return this.spawnWorker(__filename, options);
	}

	async spawnWorker(file: string, options?: WorkerOptions) {
		const node = await this._findNodeToUse();
		options = { ...this._options.defaultWorkerOptions, ...options };

		options.env = {
			...process.env,
			...options.env,
		};

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