import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export default async function calculateFileHash(path: string): Promise<string> {
	return new Promise((resolve) => {
		const fd = createReadStream(path);
		const hash = createHash('sha1');
		hash.setEncoding('hex');

		fd.on('end', function() {
			hash.end();
			resolve(hash.read());
		});

		// read all file and pipe it (write it) to the hash object
		fd.pipe(hash);
	});
}