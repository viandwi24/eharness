// A test result in plain words: did the trigger match, what would happen, what went wrong.
import type { DryRunResult } from './scripts.js';

export type Verdict = { tone: 'ok' | 'warn' | 'bad'; title: string; lines: string[] };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One line per side effect the run would have had. */
function effectLine(method: string, args: Record<string, unknown>): string {
	switch (method) {
		case 'channels.send':
			return `Would send to ${str(args.chat) || '?'}: “${str(args.text).slice(0, 120)}”`;
		case 'channels.reply':
			return `Would reply: “${str(args.text).slice(0, 120)}”`;
		case 'tables.insert':
			return `Would add ${Array.isArray(args.rows) ? args.rows.length : '?'} row(s) to ${str(args.table)}`;
		case 'tables.update':
			return `Would change rows of ${str(args.table)}`;
		case 'tables.delete':
			return `Would delete rows of ${str(args.table)}`;
		case 'library.write':
			return `Would write ${str(args.path)}`;
		case 'kv.set':
			return `Would remember ${str(args.key)}`;
		case 'kv.delete':
			return `Would forget ${str(args.key)}`;
		case 'http.request':
			return `Would call ${str(args.method)} ${str(args.url)}`;
		case 'agent.wake':
			return `Would wake ${str(args.agent)} (a paid model turn)`;
		case 'programs.run':
			return `Would start program ${str(args.program)}`;
		default:
			return `Would call ${method}`;
	}
}

export function verdictOf(r: DryRunResult): Verdict {
	const run = r.run;
	const noMatch = r.triggers.length > 0 && !r.triggers.includes('match');
	const matchLine = noMatch ? `The trigger would not start it for this event: ${r.triggers.join('; ')}.` : null;
	if (run.outcome !== 'ok') {
		const failed = run.calls.find((c) => !c.ok);
		return {
			tone: 'bad',
			title: run.outcome === 'timeout' ? 'It took too long' : run.outcome === 'limit' ? 'It hit a limit' : 'It failed',
			lines: [run.error ?? failed?.error ?? run.outcome, ...(failed && failed.error !== run.error ? [`At ctx.${failed.method}: ${failed.error ?? ''}`] : []), ...(matchLine ? [matchLine] : [])]
		};
	}
	const effects = run.calls.filter((c) => c.dryRun).map((c) => effectLine(c.method, (c.args ?? {}) as Record<string, unknown>));
	if (noMatch)
		return { tone: 'warn', title: 'The code works, but this event would not start it', lines: [matchLine!, ...effects.slice(0, 5)] };
	return {
		tone: 'ok',
		title: effects.length ? 'Works' : 'Works, and would change nothing',
		lines: effects.length ? [...effects.slice(0, 6), ...(effects.length > 6 ? [`… and ${effects.length - 6} more`] : [])] : ['No messages, rows or files would change.']
	};
}
