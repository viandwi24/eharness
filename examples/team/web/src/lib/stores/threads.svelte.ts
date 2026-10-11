import { api } from '../api/index';
import { createThreadsCore, emptyThreadsState } from './threads-core';

/** Shared chat threads store (Svelte 5 runes); logic lives in `threads-core.ts`. */
const state = $state(emptyThreadsState());
export const threadsStore = createThreadsCore(api, state);
