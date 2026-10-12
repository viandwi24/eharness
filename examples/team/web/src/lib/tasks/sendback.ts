import type { components } from '../api/schema';

type Program = components['schemas']['Program'];
type Task = components['schemas']['Task'];

/**
 * The manual worker program that picks up a task sent back (the one the server's hint names): an
 * active worker program of the task's agent whose trigger is manual and, when a scheduled worker
 * exists, none (the schedule handles it). Null = nothing to run by hand.
 */
export function manualWorker(task: Pick<Task, 'agentId'>, programs: readonly Program[]): Program | null {
	const workers = programs.filter((p) => p.worker !== null && p.agentId === task.agentId && p.status === 'active');
	if (workers.some((p) => p.trigger.kind === 'schedule')) return null;
	return workers.find((p) => p.trigger.kind === 'manual') ?? workers[0] ?? null;
}
