import { api } from '../api/index';
import { createFlowSession, emptyFlowSession } from './flow-core';

/** A reactive connect flow (one per dialog). */
export function newFlowSession(): ReturnType<typeof createFlowSession> {
	const state = $state(emptyFlowSession());
	return createFlowSession(api, state);
}
