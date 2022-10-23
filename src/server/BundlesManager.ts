import { join } from 'path';
import { tmpdir } from 'node:os';
import { existsSync, readdirSync, mkdirSync, writeFileSync, statSync, rmSync } from 'fs';

import { Express } from 'express';

/**
 * @internal
 */
export default class BundlesManager {
	private _http: Express;
	public tmpDir: string;
	public cachedBundledHashes: string[];

	constructor(http: Express) {
		this._http = http;
		this.tmpDir = join(tmpdir(), 'workers-nodes-bundled');
		this.cachedBundledHashes = this.getCachedBundledHashes();


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

			return res.status(204).end();
		});
	}


	public clearAllCachedBundles() {
		rmSync(this.tmpDir, { 'recursive': true, 'force': true });
		mkdirSync(this.tmpDir);

		this.cachedBundledHashes = [];
	}

	private getCachedBundledHashes() {
		const tempDirectory = this.tmpDir;
		if(!existsSync(tempDirectory)) mkdirSync(tempDirectory);

		const files = readdirSync(tempDirectory);
		const hashes = files.map((f) => f.split('.')[0]);
		return hashes;
	}
}