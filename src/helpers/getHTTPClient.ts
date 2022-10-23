import http from 'http';
import https from 'https';

// Get auth defaults from URL
// "http://john:doe@example.com" -> { "username": "john", "password": "doe" }
export default function getHTTPClient(url: string): typeof http | typeof https {
	const u = new URL(url);
	if(u.protocol == 'http:') return http;
	return https;
}