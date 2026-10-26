// Ready-made scripts: pick one, fill a few fields (chats, words, a table), get working code and a
// manifest with exactly the grants it needs. The code stays editable afterwards.

export type RecipeField =
	| { key: string; kind: 'chat'; label: string; help?: string; optional?: boolean }
	| { key: string; kind: 'words'; label: string; help?: string; optional?: boolean }
	| { key: string; kind: 'text'; label: string; help?: string; placeholder?: string; optional?: boolean; multiline?: boolean }
	| { key: string; kind: 'table'; label: string; help?: string }
	| { key: string; kind: 'agent'; label: string; help?: string }
	| { key: string; kind: 'time'; label: string; help?: string };

export type ChatValue = { connection: string; chat: string };
export type RecipeValues = Record<string, string | string[] | ChatValue>;

export type Recipe = {
	id: string;
	title: string;
	summary: string;
	icon: 'forward' | 'reply' | 'table' | 'count' | 'report' | 'agent' | 'webhook' | 'task' | 'blank';
	name: string;
	fields: RecipeField[];
	build(v: RecipeValues): { source: string; manifest: Record<string, unknown>; description: string };
};

const chatOf = (v: RecipeValues, key: string): ChatValue => {
	const c = v[key];
	return typeof c === 'object' && c !== null && !Array.isArray(c) ? c : { connection: '', chat: '' };
};
const wordsOf = (v: RecipeValues, key: string): string[] => {
	const w = v[key];
	return Array.isArray(w) ? w.filter((x) => x.trim()).map((x) => x.trim()) : [];
};
const textOf = (v: RecipeValues, key: string): string => {
	const t = v[key];
	return typeof t === 'string' ? t.trim() : '';
};
const js = (s: string): string => JSON.stringify(s);

/** Channel trigger on new messages in a chat, with optional words. */
function messageTrigger(from: ChatValue, words: string[]): Record<string, unknown> {
	return {
		kind: 'channel',
		events: ['message.created'],
		...(from.connection ? { connections: [from.connection] } : {}),
		...(from.chat ? { chats: [from.chat] } : {}),
		...(words.length ? { textContains: words } : {})
	};
}

function cronAt(time: string): string {
	const [h, m] = time.split(':').map(Number);
	return `${Number.isFinite(m) ? m : 0} ${Number.isFinite(h) ? h : 9} * * *`;
}

export const RECIPES: Recipe[] = [
	{
		id: 'forward',
		title: 'Forward messages',
		summary: 'Post messages from one chat (optionally only with certain words) into another chat.',
		icon: 'forward',
		name: 'forward-messages',
		fields: [
			{ key: 'from', kind: 'chat', label: 'From chat' },
			{ key: 'words', kind: 'words', label: 'Only messages containing', help: 'Empty = every message.', optional: true },
			{ key: 'to', kind: 'chat', label: 'To chat' }
		],
		build(v) {
			const from = chatOf(v, 'from');
			const to = chatOf(v, 'to');
			const words = wordsOf(v, 'words');
			return {
				description: `Forward ${words.length ? `messages with ${words.join(', ')} ` : 'messages '}from ${from.chat || 'a chat'} to ${to.chat || 'a chat'}`,
				source: `// Forward a message to another chat.
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const who = event.actor?.name ?? event.actor?.username ?? 'Someone'
  const where = event.chat?.title ?? 'a chat'
  await ctx.channels.send({
    connection: ${js(to.connection)},
    chat: ${js(to.chat)},
    text: \`\${who} in \${where}:\\n\${event.text ?? ''}\`,
  })
  return { forwarded: true }
}
`,
				manifest: { triggers: [messageTrigger(from, words)], grants: { send: [{ connection: to.connection, chat: to.chat }] } }
			};
		}
	},
	{
		id: 'reply',
		title: 'Reply to a keyword',
		summary: 'Answer automatically when a message contains certain words (a FAQ, a link, a rule).',
		icon: 'reply',
		name: 'keyword-reply',
		fields: [
			{ key: 'from', kind: 'chat', label: 'In chat', help: 'Empty chat = any chat of the connection.' },
			{ key: 'words', kind: 'words', label: 'When a message contains' },
			{ key: 'reply', kind: 'text', label: 'Reply with', placeholder: 'Our opening hours are 9–17.', multiline: true }
		],
		build(v) {
			const from = chatOf(v, 'from');
			const words = wordsOf(v, 'words');
			return {
				description: `Reply when a message contains ${words.join(', ') || 'a keyword'}`,
				source: `// Reply in the same chat when a keyword shows up.
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  await ctx.channels.reply({ text: ${js(textOf(v, 'reply') || 'Thanks, we got your message.')} })
  return { replied: true }
}
`,
				manifest: { triggers: [messageTrigger(from, words)], grants: { reply: true }, cooldownSec: 30 }
			};
		}
	},
	{
		id: 'log',
		title: 'Save messages to a table',
		summary: 'Keep a log of messages (who, where, what, when) as rows of a table.',
		icon: 'table',
		name: 'log-messages',
		fields: [
			{ key: 'from', kind: 'chat', label: 'From chat' },
			{ key: 'words', kind: 'words', label: 'Only messages containing', optional: true },
			{ key: 'table', kind: 'table', label: 'Into table', help: 'Create the table on the Tables page first.' }
		],
		build(v) {
			const from = chatOf(v, 'from');
			const table = textOf(v, 'table');
			return {
				description: `Save messages from ${from.chat || 'a chat'} to table ${table || '?'}`,
				source: `// One row per message.
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  await ctx.tables.insert({
    table: ${js(table)},
    rows: [{
      chat: event.chat?.title ?? '',
      from: event.actor?.name ?? event.actor?.username ?? event.actor?.id ?? '',
      text: event.text ?? '',
      at: new Date(event.at ?? Date.now()).toISOString(),
    }],
  })
  return { saved: true }
}
`,
				manifest: { triggers: [messageTrigger(from, wordsOf(v, 'words'))], grants: { tablesWrite: [table] } }
			};
		}
	},
	{
		id: 'count-joins',
		title: 'Count join requests',
		summary: 'Count join requests per chat and day in a table.',
		icon: 'count',
		name: 'count-join-requests',
		fields: [{ key: 'table', kind: 'table', label: 'Counts table', help: 'Rows get chat, day and n.' }],
		build(v) {
			const table = textOf(v, 'table');
			return {
				description: `Count join requests per chat and day in ${table || '?'}`,
				source: `// Add one to today's count of the chat.
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const chat = event.chat?.title ?? 'unknown'
  const day = new Date(event.at ?? Date.now()).toISOString().slice(0, 10)
  const found = await ctx.tables.query({ table: ${js(table)}, filter: { chat, day }, limit: 1 })
  const row = found.rows[0]
  if (row) await ctx.tables.update({ table: ${js(table)}, id: row.id, inc: { n: 1 } })
  else await ctx.tables.insert({ table: ${js(table)}, rows: [{ chat, day, n: 1 }] })
  return { chat, day }
}
`,
				manifest: { triggers: [{ kind: 'channel', events: ['member.join_requested'] }], grants: { tablesWrite: [table] } }
			};
		}
	},
	{
		id: 'report',
		title: 'Daily table report',
		summary: 'Every day, count the rows of a table and write a short report to the library.',
		icon: 'report',
		name: 'daily-report',
		fields: [
			{ key: 'table', kind: 'table', label: 'Table' },
			{ key: 'time', kind: 'time', label: 'At' },
			{ key: 'folder', kind: 'text', label: 'Library folder', placeholder: '/library/reports' }
		],
		build(v) {
			const table = textOf(v, 'table');
			const folder = (textOf(v, 'folder') || '/library/reports').replace(/\/+$/, '');
			return {
				description: `Daily report of table ${table || '?'} into ${folder}`,
				source: `// Write today's numbers to a markdown file.
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const { total } = await ctx.tables.query({ table: ${js(table)}, limit: 1 })
  const day = new Date().toISOString().slice(0, 10)
  const path = \`${folder}/${table || 'table'}-\${day}.md\`
  await ctx.library.write({ path, content: \`# ${table || 'Table'} on \${day}\\n\\nRows: \${total}\\n\` })
  return { path, total }
}
`,
				manifest: {
					triggers: [{ kind: 'schedule', spec: { kind: 'cron', expr: cronAt(textOf(v, 'time') || '23:00') } }],
					grants: { tablesRead: [table], libraryWrite: [`${folder}/**`] }
				}
			};
		}
	},
	{
		id: 'escalate',
		title: 'Ask an agent when needed',
		summary: 'Let rules filter first and wake an agent only for messages that need a person-like answer.',
		icon: 'agent',
		name: 'escalate-to-agent',
		fields: [
			{ key: 'from', kind: 'chat', label: 'In chat' },
			{ key: 'words', kind: 'words', label: 'When a message contains' },
			{ key: 'agent', kind: 'agent', label: 'Wake agent', help: 'A wake is a paid model turn.' }
		],
		build(v) {
			const from = chatOf(v, 'from');
			const agent = textOf(v, 'agent');
			return {
				description: `Wake ${agent || 'an agent'} on ${wordsOf(v, 'words').join(', ') || 'keywords'}`,
				source: `// Wake the agent with what happened; it decides what to do.
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  await ctx.agent.wake({
    agent: ${js(agent)},
    instruction: \`A message in \${event.chat?.title ?? 'a chat'} from \${event.actor?.name ?? 'someone'} needs a look: \${(event.text ?? '').slice(0, 500)}\`,
  })
  return { woke: true }
}
`,
				manifest: { triggers: [messageTrigger(from, wordsOf(v, 'words'))], grants: { wake: [agent] }, cooldownSec: 60 }
			};
		}
	},
	{
		id: 'webhook',
		title: 'Webhook to a chat',
		summary: 'Another system (a shop, a form, CI) POSTs to a secret URL; post what it sends into a chat.',
		icon: 'webhook',
		name: 'webhook-to-chat',
		fields: [{ key: 'to', kind: 'chat', label: 'Post into chat' }],
		build(v) {
			const to = chatOf(v, 'to');
			return {
				description: `Post webhook calls into ${to.chat || 'a chat'}`,
				source: `// Runs on a POST to the webhook URL (Triggers & permissions shows it).
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const body = event.body
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  await ctx.channels.send({ connection: ${js(to.connection)}, chat: ${js(to.chat)}, text: \`New webhook call:\n\${text.slice(0, 3000)}\` })
  return { posted: true }
}
`,
				manifest: { triggers: [{ kind: 'webhook' }], grants: { send: [{ connection: to.connection, chat: to.chat }] }, maxRunsPerHour: 120 }
			};
		}
	},
	{
		id: 'task-done',
		title: 'Tell a chat when work is done',
		summary: 'When an agent finishes a task, post its title into a chat.',
		icon: 'task',
		name: 'task-done-notice',
		fields: [
			{ key: 'agent', kind: 'agent', label: 'Tasks of agent', help: 'Pick one agent, or leave empty for all.' },
			{ key: 'to', kind: 'chat', label: 'Post into chat' }
		],
		build(v) {
			const to = chatOf(v, 'to');
			const agent = textOf(v, 'agent');
			return {
				description: `Post finished tasks${agent ? ` of ${agent}` : ''} into ${to.chat || 'a chat'}`,
				source: `// Runs when a task changes to done (see the trigger's condition).
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const p = event.payload ?? {}
  await ctx.channels.send({ connection: ${js(to.connection)}, chat: ${js(to.chat)}, text: \`Done: \${String(p.title ?? 'a task')}\` })
  return { posted: true }
}
`,
				manifest: {
					triggers: [{ kind: 'app', events: ['task-changed'], ...(agent ? { agents: [agent] } : {}), match: { status: 'done' } }],
					grants: { send: [{ connection: to.connection, chat: to.chat }] }
				}
			};
		}
	},
	{
		id: 'blank',
		title: 'Start from scratch',
		summary: 'An empty script with comments. Add triggers and permissions yourself.',
		icon: 'blank',
		name: 'my-script',
		fields: [],
		build() {
			return {
				description: '',
				source: `// \`event\` is what started the run; \`ctx\` is the only way to reach the system.
// Press Ctrl+Space for suggestions. Test with the panel on the right.
export default async function (event: ScriptEvent, ctx: ScriptContext) {
  ctx.log('event', event.type, event.text ?? '')
  return { ok: true }
}
`,
				manifest: { triggers: [], grants: {} }
			};
		}
	}
];

/** The fields a recipe still needs (not optional and empty). */
export function missingFields(r: Recipe, v: RecipeValues): string[] {
	const out: string[] = [];
	for (const f of r.fields) {
		if ('optional' in f && f.optional) continue;
		if (r.id === 'task-done' && f.key === 'agent') continue;
		const x = v[f.key];
		const empty =
			f.kind === 'chat'
				? !(typeof x === 'object' && x !== null && !Array.isArray(x) && x.connection && (x.chat || r.id === 'reply'))
				: f.kind === 'words'
					? !(Array.isArray(x) && x.length)
					: !(typeof x === 'string' && x.trim());
		if (empty) out.push(f.label);
	}
	return out;
}
