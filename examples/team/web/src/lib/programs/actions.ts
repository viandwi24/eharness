import { api } from '../api/index';
import type { components } from '../api/schema';
import { toast } from '../components/ui/sonner/index.js';
import { live } from '../stores/live.svelte.js';

type Program = components['schemas']['Program'];

/** Pause, resume or run a program now; toasts the outcome and bumps the live programs rev. */
export async function programAction(p: Program, action: 'pause' | 'resume' | 'run'): Promise<boolean> {
	try {
		await api.post(`/programs/{id}/${action}`, { params: { id: p.id } });
		if (action === 'run') toast.success(`${p.name} started`);
		live.state.revs.programs++;
		return true;
	} catch (e) {
		toast.error(e instanceof Error ? e.message : `Could not ${action} the program`);
		return false;
	}
}
