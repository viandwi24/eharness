import { api } from '../api/index';
import type { components } from '../api/schema';
import { toast } from '../components/ui/sonner/index.js';
import { live } from '../stores/live.svelte.js';

type Routine = components['schemas']['Routine'];

/** Pause, resume or run a routine now; toasts the outcome and bumps the live routines rev. */
export async function routineAction(r: Routine, action: 'pause' | 'resume' | 'run'): Promise<boolean> {
	try {
		await api.post(`/routines/{id}/${action}`, { params: { id: r.id } });
		if (action === 'run') toast.success(`${r.name} started`);
		live.state.revs.routines++;
		return true;
	} catch (e) {
		toast.error(e instanceof Error ? e.message : `Could not ${action} the routine`);
		return false;
	}
}
