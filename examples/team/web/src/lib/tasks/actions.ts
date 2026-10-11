import { api } from '../api/index';
import { toast } from '../components/ui/sonner/index.js';
import { live } from '../stores/live.svelte.js';
import type { Priority } from './queue';

async function run(label: string, call: () => Promise<unknown>, done: string): Promise<boolean> {
	try {
		await call();
		toast.success(done);
		void live.loadTasks();
		return true;
	} catch (e) {
		toast.error(e instanceof Error ? e.message : `Could not ${label}`);
		return false;
	}
}

/** The client accepts finished work in Review. */
export const acceptTask = (id: string): Promise<boolean> => run('accept the task', () => api.post('/tasks/{id}/accept', { params: { id } }), 'Accepted');

/** Send finished (or failed) work back: it is queued again with the note appended to its brief. */
export const sendBackTask = (id: string, note: string): Promise<boolean> =>
	run('send the task back', () => api.post('/tasks/{id}/send-back', { params: { id }, body: { note } }), 'Sent back: it is queued again');

/** Cancel a task that has not started. */
export const cancelTask = (id: string): Promise<boolean> => run('cancel the task', () => api.post('/tasks/{id}/cancel', { params: { id } }), 'Task cancelled');

/** Re-prioritise a queued task. */
export const setPriority = (id: string, priority: Priority): Promise<boolean> =>
	run('change the priority', () => api.patch('/tasks/{id}', { params: { id }, body: { priority } }), 'Priority changed');
