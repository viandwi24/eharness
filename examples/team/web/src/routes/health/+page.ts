import { redirect } from '@sveltejs/kit';

// The Health page became "Needs attention" (docs/plans/P55-consolidation.md); old links keep working.
export const load = (): never => redirect(307, '/attention');
