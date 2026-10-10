import { api } from '../api/index';
import { createProvidersCore, emptyProvidersState } from './store-core';

/** Provider definitions, profiles and their model lists (`GET /providers`). */
const state = $state(emptyProvidersState());
export const providersStore = createProvidersCore(api, state);
