'use strict';

import fetch from 'node-fetch';
import { expect } from 'chai';
import { Server } from '../dist/index';
import { getCPUUsage } from '../src/helpers/cpu';


// always use random number for server ports
const port = Math.floor(Math.random() * 10000) + 1000;
console.log('using port', port);


describe('helpers', () => {
	it('should be able to get cpu usage of all cpus', async () => {
		const usage = await getCPUUsage();

		// we should have at least 1 cpu
		expect(usage.length).greaterThan(0);
		// console.log(usage);
	})	
});


describe('server class', () => {
	it('should create an instance using its constructor', () => {
		const server: Server = new Server({ auth: { username: 'asdf', password: 'asdf' }, port });
		expect(server, 'server should exist').to.exist; // tslint:disable-line:no-unused-expression
	});

	it('should be able to start the http server', async () => {
		const server: Server = new Server({ auth: { username: 'asdf', password: 'asdf' }, port });
		await server.start();

		const req = await fetch(`http://localhost:${port}`);
		expect(req.status).greaterThan(0);
	});
});
