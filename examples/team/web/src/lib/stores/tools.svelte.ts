import { api } from '../api/index';
import { createToolsCore, emptyToolsState } from './tools-core';

/** The fixed tool catalog (`GET /tools`), loaded once. */
const state = $state(emptyToolsState());
export const toolsStore = createToolsCore(api, state);
