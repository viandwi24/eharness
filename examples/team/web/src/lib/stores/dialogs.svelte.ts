// App-wide modal dialogs (one instance each, mounted in the root layout). Any component opens them
// through these functions; the dialogs read the state.

export type AgentTab = 'settings' | 'persona' | 'memory' | 'connectors' | 'heartbeat';

/** The agent dialog: `mode: 'create'` for a new agent, `'edit'` for an existing one (`agentId`). */
export const agentDialog = $state<{ open: boolean; mode: 'create' | 'edit'; agentId: string | null; tab: AgentTab }>({
	open: false,
	mode: 'create',
	agentId: null,
	tab: 'settings'
});

export function openNewAgent(): void {
	agentDialog.mode = 'create';
	agentDialog.agentId = null;
	agentDialog.tab = 'settings';
	agentDialog.open = true;
}

export function openEditAgent(agentId: string, tab: AgentTab = 'settings'): void {
	agentDialog.mode = 'edit';
	agentDialog.agentId = agentId;
	agentDialog.tab = tab;
	agentDialog.open = true;
}

export function closeAgentDialog(): void {
	agentDialog.open = false;
}

/** The program dialog: create (optionally for a preset agent) or edit one program. */
export const programDialog = $state<{ open: boolean; programId: string | null; agentId: string | null; worker: boolean }>({
	open: false,
	programId: null,
	agentId: null,
	worker: false
});

/** `worker`: the new program starts as a worker of the agent's task queue. */
export function openNewProgram(agentId: string | null = null, worker = false): void {
	programDialog.programId = null;
	programDialog.agentId = agentId;
	programDialog.worker = worker;
	programDialog.open = true;
}

export function openEditProgram(programId: string): void {
	programDialog.programId = programId;
	programDialog.agentId = null;
	programDialog.worker = false;
	programDialog.open = true;
}

export function closeProgramDialog(): void {
	programDialog.open = false;
}
