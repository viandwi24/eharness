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
	icon: 'forward' | 'reply' | 'table' | 'count' | 'report' | 'agent' | 'webhook' | 'task' | 'copy' | 'shield' | 'clock' | 'blank';
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
		id: 'distribute',
		title: 'Signal distributor',
		summary: 'Copy posts (albums too) from a source chat to one chat, or in turn to two; replies, edits and deletions follow each copy.',
		icon: 'copy',
		name: 'signal-distributor',
		fields: [
			{ key: 'from', kind: 'chat', label: 'Source chat' },
			{ key: 'to', kind: 'chat', label: 'Copy to' },
			{ key: 'to2', kind: 'chat', label: 'And in turn to', help: 'Optional: posts alternate between the two chats.', optional: true },
			{ key: 'words', kind: 'words', label: 'Only posts containing', help: 'Empty = every post. Replies always follow their copy.', optional: true }
		],
		build(v) {
			const from = chatOf(v, 'from');
			const to = chatOf(v, 'to');
			const to2 = chatOf(v, 'to2');
			const words = wordsOf(v, 'words');
			const targets = [to.chat, ...(to2.chat ? [to2.chat] : [])];
			return {
				description: `Copy posts from ${from.chat || 'a chat'} to ${targets.join(' and ') || 'a chat'}, keeping replies, edits and deletions in step`,
				source: `// Pass posts on as copies (an album stays an album, formatting is kept, nothing is downloaded).
// Replies, edits and deletions in the source chat follow each copy.
const TARGETS: string[] = ${JSON.stringify(targets)}
const WORDS: string[] = ${JSON.stringify(words)}

export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const c = event.connectionId ?? ''
  const here = { connection: c, chat: event.chat?.nativeId ?? '' }
  if (event.type === 'message.deleted') {
    for (const id of event.messageIds ?? []) {
      const { copies } = await ctx.channels.copies({ ...here, messageId: id })
      for (const k of copies) await ctx.channels.delete({ connection: c, chat: k.chat, topic: k.topic, messageIds: [k.messageId] })
    }
    return { deleted: event.messageIds?.length ?? 0 }
  }
  if (event.type === 'message.edited') {
    const { copies } = await ctx.channels.copies({ ...here, messageId: event.messageId ?? '' })
    for (const k of copies) await ctx.channels.edit({ connection: c, chat: k.chat, topic: k.topic, messageId: k.messageId, text: event.text ?? '' })
    return { edited: copies.length }
  }
  if (event.replyTo) {
    // a reply to a copied post: copy it as a reply under each copy
    const { copies } = await ctx.channels.copies({ ...here, messageId: event.replyTo.messageId })
    for (const k of copies)
      await ctx.channels.copy({ ...here, messageIds: [event.messageId ?? ''], toChat: k.chat, toTopic: k.topic, replyTo: k.messageId })
    return { followed: copies.length }
  }
  const text = (event.text ?? '').toLowerCase()
  if (WORDS.length > 0 && !WORDS.some((w) => text.includes(w.toLowerCase()))) return { skipped: 'no signal word' }
  const turn = (await ctx.kv.incr({ key: 'turn' })).value
  const to = TARGETS[(turn - 1) % TARGETS.length]
  const ids = event.album ? event.album.map((m) => m.messageId) : [event.messageId ?? '']
  const sent = await ctx.channels.copy({ ...here, messageIds: ids, toChat: to })
  return { copied: sent.messageIds.length, to }
}
`,
				manifest: {
					triggers: [{ ...messageTrigger(from, []), events: ['message.created', 'message.edited', 'message.deleted'] }],
					grants: {
						read: from.connection && from.chat ? [{ connection: from.connection, chat: from.chat }] : [],
						send: targets.filter(Boolean).map((chat) => ({ connection: from.connection || to.connection, chat }))
					}
				}
			};
		}
	},
	{
		id: 'signal-log',
		title: 'Signal log with outcomes',
		summary: 'Log posts with signal words to a table; a reply with TP or SL marks the outcome.',
		icon: 'table',
		name: 'signal-log',
		fields: [
			{ key: 'from', kind: 'chat', label: 'Signals chat' },
			{ key: 'words', kind: 'words', label: 'A signal contains', help: 'e.g. buy, sell, long, short' },
			{ key: 'table', kind: 'table', label: 'Table', help: 'Make its "message" field unique so a post is logged once.' }
		],
		build(v) {
			const from = chatOf(v, 'from');
			const words = wordsOf(v, 'words');
			const table = textOf(v, 'table');
			return {
				description: `Log signals from ${from.chat || 'a chat'} to ${table || 'a table'} with their outcome`,
				source: `// One row per signal (keyed by its message id); a reply that says TP or SL sets the outcome.
const TABLE = ${js(table)}
const WORDS: string[] = ${JSON.stringify(words)}

export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const text = event.text ?? ''
  if (event.replyTo) {
    const outcome = /\\b(sl|stop)\\b/i.test(text) ? 'stopped' : /\\btp\\s*\\d*\\b|target/i.test(text) ? 'target hit' : undefined
    if (!outcome) return { skipped: 'no outcome in the reply' }
    return ctx.tables.update({ table: TABLE, filter: { message: event.replyTo.messageId }, set: { status: outcome, outcome_text: text } })
  }
  const lower = text.toLowerCase()
  if (!WORDS.some((w) => lower.includes(w.toLowerCase()))) return { skipped: 'not a signal' }
  return ctx.tables.upsert({
    table: TABLE,
    key: 'message',
    rows: [{ message: event.messageId, chat: event.chat?.title ?? '', from: event.actor?.name ?? '', text, status: 'open', at: new Date(event.at ?? Date.now()).toISOString() }],
  })
}
`,
				manifest: { triggers: [messageTrigger(from, [])], grants: { tablesWrite: table ? [table] : [] } }
			};
		}
	},
	{
		id: 'welcome-captcha',
		title: 'Welcome with a captcha',
		summary: 'New members stay muted until they press "I am human"; anyone who does not is removed after a while (bot connections).',
		icon: 'shield',
		name: 'welcome-captcha',
		fields: [
			{ key: 'chat', kind: 'chat', label: 'Group' },
			{ key: 'welcome', kind: 'text', label: 'Welcome text', placeholder: 'Welcome {name}! Press the button to start chatting.', optional: true, multiline: true },
			{ key: 'minutes', kind: 'text', label: 'Minutes to answer', placeholder: '5', optional: true }
		],
		build(v) {
			const chat = chatOf(v, 'chat');
			const minutes = Math.min(Math.max(Number(textOf(v, 'minutes')) || 5, 1), 1440);
			const welcome = textOf(v, 'welcome') || 'Welcome {name}! Press the button to start chatting.';
			return {
				description: `New members of ${chat.chat || 'a group'} prove they are human within ${minutes} minutes`,
				source: `// A new member is muted and asked to press a button; pressing it unmutes them, silence removes them.
const WELCOME = ${js(welcome)}
const MINUTES = ${minutes}

export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const c = event.connectionId ?? ''
  const here = { connection: c, chat: event.chat?.nativeId ?? '' }
  if (event.type === 'member.joined' && event.actor && !event.actor.isSelf) {
    const user = event.actor.id
    await ctx.channels.moderate({ ...here, action: 'mute', user })
    const sent = await ctx.channels.send({
      ...here,
      text: WELCOME.replace('{name}', event.actor.name ?? 'there'),
      buttons: [[{ text: 'I am human', data: 'human:' + user }]],
    })
    await ctx.kv.set({ key: 'captcha:' + user, value: sent.messageIds[0], ttlSec: MINUTES * 60 + 600 })
    await ctx.later({ in: MINUTES * 60, data: { user, ...here }, key: 'captcha:' + user })
    return { asked: user }
  }
  if (event.type === 'action' && event.button?.data?.startsWith('human:')) {
    const user = event.button.data.slice('human:'.length)
    if (event.actor?.id !== user) return { skipped: 'someone else pressed it' }
    await ctx.channels.moderate({ ...here, action: 'unmute', user })
    await ctx.cancelLater({ key: 'captcha:' + user })
    await ctx.kv.delete({ key: 'captcha:' + user })
    await ctx.channels.edit({ ...here, messageId: event.messageId ?? '', text: 'Welcome, ' + (event.actor?.name ?? 'friend') + '!', buttons: [] })
    return { passed: user }
  }
  if (event.type === 'later') {
    const d = event.data as { user: string; connection: string; chat: string }
    const pending = (await ctx.kv.get({ key: 'captcha:' + d.user })).value
    if (pending === null) return { skipped: 'already answered' }
    await ctx.channels.moderate({ connection: d.connection, chat: d.chat, action: 'kick', user: d.user })
    await ctx.channels.delete({ connection: d.connection, chat: d.chat, messageIds: [String(pending)] })
    await ctx.kv.delete({ key: 'captcha:' + d.user })
    return { removed: d.user }
  }
  return { skipped: event.type }
}
`,
				manifest: {
					triggers: [{ ...messageTrigger(chat, []), events: ['member.joined', 'action'] }],
					grants: chat.connection && chat.chat ? { send: [{ connection: chat.connection, chat: chat.chat }], moderate: [{ connection: chat.connection, chat: chat.chat }] } : {}
				}
			};
		}
	},
	{
		id: 'antiflood',
		title: 'Antiflood',
		summary: 'Mute a member who posts too many messages a minute (admins are left alone).',
		icon: 'shield',
		name: 'antiflood',
		fields: [
			{ key: 'chat', kind: 'chat', label: 'Group' },
			{ key: 'limit', kind: 'text', label: 'Messages a minute', placeholder: '5', optional: true },
			{ key: 'minutes', kind: 'text', label: 'Mute for (minutes)', placeholder: '10', optional: true }
		],
		build(v) {
			const chat = chatOf(v, 'chat');
			const limit = Math.min(Math.max(Number(textOf(v, 'limit')) || 5, 1), 100);
			const minutes = Math.min(Math.max(Number(textOf(v, 'minutes')) || 10, 1), 10080);
			return {
				description: `Mute members of ${chat.chat || 'a group'} who send more than ${limit} messages a minute`,
				source: `// More than LIMIT messages in a minute: muted for MINUTES (owners and admins are never muted).
const LIMIT = ${limit}
const MINUTES = ${minutes}

export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const a = event.actor
  if (!a || a.isSelf || a.role === 'owner' || a.role === 'admin') return { skipped: 'staff or the bot' }
  const rl = await ctx.kv.rateLimit({ key: 'flood:' + a.id, limit: LIMIT, windowSec: 60 })
  if (rl.allowed) return { ok: true, left: rl.remaining }
  const here = { connection: event.connectionId ?? '', chat: event.chat?.nativeId ?? '' }
  // once per window: the person is muted already
  if (!(await ctx.kv.once({ key: 'muted:' + a.id, ttlSec: MINUTES * 60 })).first) return { skipped: 'muted already' }
  await ctx.channels.moderate({ ...here, action: 'mute', user: a.id, forSec: MINUTES * 60 })
  await ctx.channels.reply({ text: (a.name ?? 'Someone') + ' is muted for ' + MINUTES + ' minutes: too many messages.', quote: false })
  return { muted: a.id }
}
`,
				manifest: {
					triggers: [messageTrigger(chat, [])],
					grants: { reply: true, ...(chat.connection && chat.chat ? { moderate: [{ connection: chat.connection, chat: chat.chat }] } : {}) }
				}
			};
		}
	},
	{
		id: 'scheduled-post',
		title: 'Scheduled post',
		summary: 'Post a message (and a library file, like a chart) to a chat every day at a time.',
		icon: 'clock',
		name: 'daily-post',
		fields: [
			{ key: 'to', kind: 'chat', label: 'Post to' },
			{ key: 'time', kind: 'time', label: 'Every day at' },
			{ key: 'text', kind: 'text', label: 'Text', placeholder: 'Good morning! Today’s plan…', multiline: true },
			{ key: 'file', kind: 'text', label: 'Library file', placeholder: '/library/charts/today.png', help: 'Optional: a photo or file to post with the text.', optional: true }
		],
		build(v) {
			const to = chatOf(v, 'to');
			const file = textOf(v, 'file');
			const time = textOf(v, 'time') || '09:00';
			return {
				description: `Post to ${to.chat || 'a chat'} every day at ${time}`,
				source: `// A post at a fixed time; the file (when set) goes along as a photo or document.
const TEXT = ${js(textOf(v, 'text') || 'Good morning!')}
const FILE = ${js(file)}

export default async function (event: ScriptEvent, ctx: ScriptContext) {
  const sent = await ctx.channels.send({
    connection: ${js(to.connection)},
    chat: ${js(to.chat)},
    text: TEXT,
    ...(FILE ? { files: [FILE] } : {}),
  })
  return { posted: sent.messageIds }
}
`,
				manifest: {
					triggers: [{ kind: 'schedule', spec: { kind: 'cron', expr: cronAt(time) } }],
					grants: { send: to.connection && to.chat ? [{ connection: to.connection, chat: to.chat }] : [], ...(file ? { libraryRead: [file] } : {}) }
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
