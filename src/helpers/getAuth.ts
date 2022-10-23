import { ServerAuth } from '../server/Server';

// Get auth defaults from URL
// "http://john:doe@example.com" -> { "username": "john", "password": "doe" }
export default function getAuth(url: string): ServerAuth {
	const u = new URL(url);
	const auth = u.href.replace(`${u.protocol}//`, '').split('@')[0];

	const username = auth.split(':')[0];
	const password = auth.split(':')[1];

	return {
		username,
		password
	}
}