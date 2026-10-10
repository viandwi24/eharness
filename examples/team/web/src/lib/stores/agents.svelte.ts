import { api } from '../api/index';
import { createAgentsCore, emptyAgentsState } from './agents-core';

/** Shared agents store (Svelte 5 runes). Logic lives in `agents-core.ts` so it is testable without Svelte. */
const state = $state(emptyAgentsState());
export const agentsStore = createAgentsCore(api, state);
