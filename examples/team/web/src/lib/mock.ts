// MOCK DATA: placeholders for parts the API does not serve yet. Agents now come from the API
// (`$lib/stores/agents.svelte.ts`). Still mocked: `messages` (chat fixtures), `routines`, `files`,
// `tasks`, and `models` (see `$lib/models.ts` for the static model list). `agents` below is used
// only to resolve fixture message authors in ChatPane.

// MOCK: fixture authors only
export type MockAgent = {
	id: string;
	name: string;
	role: string;
	preview: string;
	time: string;
	unread: boolean;
};

export const agents: MockAgent[] = [
	{ id: 'lead', name: 'Lead', role: 'Coordinates the team', preview: 'Researcher is on the competitor scan.', time: '9:41', unread: true },
	{ id: 'researcher', name: 'Researcher', role: 'Web search and fetch', preview: 'Found 6 sources, writing /research/notes.md', time: '9:12', unread: false },
	{ id: 'writer', name: 'Writer', role: 'Drafts documents', preview: 'Draft v2 is in the library.', time: 'Yesterday', unread: false },
	{ id: 'analyst', name: 'Analyst', role: 'Numbers and scripts', preview: 'Weekly cost report is ready.', time: 'Mon', unread: true }
];

export type MockMessage = { id: string; from: 'user' | 'assistant'; agentId?: string; text: string };

export const messages: MockMessage[] = [
	{ id: 'm1', from: 'user', text: 'Can you scan our top three competitors and summarise pricing changes?' },
	{
		id: 'm2',
		from: 'assistant',
		agentId: 'lead',
		text: 'On it. I asked **Researcher** to collect pricing pages and **Writer** to prepare a one page summary.\n\n- Researcher: web search and fetch\n- Writer: drafts into `/research/pricing.md`'
	},
	{ id: 'm3', from: 'assistant', agentId: 'lead', text: 'Researcher is on the competitor scan. I will report when the draft is ready.' }
];

export const routines = [
	{ id: 'r1', name: 'Morning briefing', schedule: 'Weekdays 08:30', status: 'active' },
	{ id: 'r2', name: 'Weekly cost report', schedule: 'Mondays 09:00', status: 'paused' }
];

export const files = [
	{ path: '/research/pricing.md', kind: 'markdown', by: 'Writer' },
	{ path: '/research/notes.md', kind: 'markdown', by: 'Researcher' },
	{ path: '/reports/costs-week-41.csv', kind: 'csv', by: 'Analyst' }
];

export type MockTask = { id: string; title: string; agentId: string; column: 'needs-action' | 'running' | 'done' };

export const tasks: MockTask[] = [
	{ id: 't1', title: 'Approve: fetch competitor pricing pages', agentId: 'researcher', column: 'needs-action' },
	{ id: 't2', title: 'Competitor pricing summary', agentId: 'writer', column: 'running' },
	{ id: 't3', title: 'Weekly cost report', agentId: 'analyst', column: 'running' },
	{ id: 't4', title: 'Morning briefing', agentId: 'lead', column: 'done' }
];

export const models = [
	{ id: 'default', label: 'Workspace default' },
	{ id: 'fast', label: 'Fast' },
	{ id: 'smart', label: 'Smart' }
];
