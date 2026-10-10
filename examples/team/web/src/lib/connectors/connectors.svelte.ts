import { api } from '../api/index';
import { createConnectorsCore, emptyConnectorsState } from './core';

/** The connector catalog and the connections, loaded on demand and kept fresh by the pages. */
const state = $state(emptyConnectorsState());
export const connectorsStore = createConnectorsCore(api, state);
