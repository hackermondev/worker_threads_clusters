Split CPU-intensive tasks on multiple servers (nodes) through node worker_threads.

# Installation
```bash
npm install worker_threads_clusters
```

# What does this do?
Node.js offers a feature called ``worker_threads`` that allows you to launch other node files as threads on the main node program. This can be useful for running programs that might block the event loop or for running CPU-intensive programs.

This package takes that concept one step further by allowing you to spawn workers on different servers (referred to as clusters). This way, you can run CPU-intensive tasks on server clusters and then get the response on the main server without any complicated back-end work.



# Example Usage


### Main Program (the "client")
```js
const { Client } = require('worker_threads_clusters');



// choicesBehavior is how what node should be picked
// 'random' | 'incremental' | 'balancing'
/*
random -  pick a random node
incremental - use the nodes in order, first worker on first node, 2nd worker on 2nd node, etc and it keeps resetting back to first worker and continues the cycle
balancing - it will fetch the cpu(s) usage of all the nodes and choose the best one to spawn the worker based on the usage percentage 
*/

const c = new Client({ choicesBehavior: 'random' });

// connection transport is done through HTTP (udp support coming soon)
c.addNode('http://username:password@node1.clusters.local');
c.addNode('http://username:password@node2.clusters.local');
c.addNode('http://username:password@node3.clusters.local');
c.addNode('http://username:password@node4.clusters.local');
c.addNode('http://username:password@node5.clusters.local');


(async () => {
	// a node is first chosen
	// then the "run.js" file gets bundled with esbuild and uploaded to the node
    // worker will then be launched on node
	const worker = await c.spawnWorker('run.js');
	worker.on('online', () => console.log('worker is online'));
	worker.on('error', () => console.log('error'));
	worker.on('exit', () => console.log('exit'));
	worker.on('message', (data) => console.log('recieved message:', data));

	setInterval(()=>{
		worker.postMessage('balls');
	}, 1000)
})();
```


### Node (the "server")
```js
const { Server } = require('worker_threads_clusters');


const s = new Server({
	auth: { 
	    username: 'username',
	    password: 'password' 
    },
    
	port: 80,
});

s.start();
// the server will automatically start processing requests from clients
```

### Worker (run.js)
```js
const { isMainThread, parentPort } = require('worker_threads');

if(!isMainThread) {
	console.log("yooooo i'm alive!!!!")
	parentPort.on("message", (data) => {
		// messages can be sent and recieved
		console.log('got message:', data);
		parentPort.send(data);
	});

	doSomethingReallyIntensiveCpuTask();
} else {
	console.log("run me through a worker, smh")
}

```

# About
<details>
<summary><strong>Contributing</strong></summary>

Pull requests and stars are always welcome. For bugs and feature requests, [please create an issue](../../issues/new).

</details>

<details>


<summary><strong>Running Tests</strong></summary>

Running and reviewing unit tests is a great way to get familiarized with a library and its API. You can install dependencies and run tests with the following command:

```sh
$ npm install && npm test
```

</details>



# API
Soon

# TODO
This is sort of an unfinished project. Right now, everything mentioned previously is implemented and new things are coming soon.

- UDP connection transport
- Finish working on tests
- Docs

# License

Copyright © 2022, [Hackermon](https://github.com/hackermondev).
Released under the [MIT License](LICENSE).