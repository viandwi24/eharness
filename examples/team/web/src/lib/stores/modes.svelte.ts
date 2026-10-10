import { api } from '../api/index';
import { createModesCore, emptyModesState } from './modes-core';

/** Shared permission mode store (Svelte 5 runes); logic lives in `modes-core.ts`. */
const state = $state(emptyModesState());
export const modesStore = createModesCore(api, state);
