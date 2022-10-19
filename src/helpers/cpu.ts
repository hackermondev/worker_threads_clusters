import { cpus } from 'node:os';


let timesBefore = cpus().map(c => c.times);

export async function getCPUUsage(): Promise<number[]> {
	const timesAfter = cpus().map(c => c.times);
	const timeDeltas = timesAfter.map((t, i) => ({
		user: t.user - timesBefore[i].user,
		sys: t.sys - timesBefore[i].sys,
		idle: t.idle - timesBefore[i].idle
	}));

	timesBefore = timesAfter;

	return timeDeltas
		.map(times => (1 - times.idle / (times.user + times.sys + times.idle)))
}