// App-wide modal dialogs (one instance each, mounted in the root layout). Any component opens them
// through these functions; the dialogs read the state.

/** The agent dialog: `mode: 'create'` for a new agent, `'edit'` for an existing one (`agentId`). */
export const agentDialog = $state<{ open: boolean; mode: 'create' | 'edit'; agentId: string | null }>({
	open: false,
	mode: 'create',
	agentId: null
});

export function openNewAgent(): void {
	agentDialog.mode = 'create';
	agentDialog.agentId = null;
	agentDialog.open = true;
}

export function openEditAgent(agentId: string): void {
	agentDialog.mode = 'edit';
	agentDialog.agentId = agentId;
	agentDialog.open = true;
}

export function closeAgentDialog(): void {
	agentDialog.open = false;
}

/** The routine dialog: create (optionally for a preset agent) or edit one routine. */
export const routineDialog = $state<{ open: boolean; routineId: string | null; agentId: string | null }>({
	open: false,
	routineId: null,
	agentId: null
});

export function openNewRoutine(agentId: string | null = null): void {
	routineDialog.routineId = null;
	routineDialog.agentId = agentId;
	routineDialog.open = true;
}

export function openEditRoutine(routineId: string): void {
	routineDialog.routineId = routineId;
	routineDialog.agentId = null;
	routineDialog.open = true;
}

export function closeRoutineDialog(): void {
	routineDialog.open = false;
}
