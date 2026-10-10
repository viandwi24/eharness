import { live } from './live.svelte.js';

/** Task drawer state (one drawer for the whole app). */
export const drawer = $state<{ taskId: string | null }>({ taskId: null });

export function openTask(taskId: string): void {
	drawer.taskId = taskId;
}

/** Open the drawer for a child session (SubagentPart "open session"); loads the board when needed. */
export async function openSession(sessionId: string): Promise<boolean> {
	let t = live.state.tasks.find((x) => x.sessionId === sessionId);
	if (!t) {
		await live.loadTasks();
		t = live.state.tasks.find((x) => x.sessionId === sessionId);
	}
	if (!t) return false;
	drawer.taskId = t.id;
	return true;
}

export function closeTask(): void {
	drawer.taskId = null;
}
