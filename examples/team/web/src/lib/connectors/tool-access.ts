// Pure logic of "Tool access" (Claude's Auto / On demand): how the tools of connected (non built-in)
// connectors reach the model. Mirrors the server (`TOOL_ACCESS_AUTO_THRESHOLD`, domain/agents.ts).
import type { AgentConnector } from '../api/client';

export type ToolAccess = 'auto' | 'on-demand';

/** Third-party tools an agent may have loaded up front in Auto mode before they are found on demand. */
export const AUTO_THRESHOLD = 20;

export const TOOL_ACCESS_LABEL: Record<ToolAccess, string> = { auto: 'Auto', 'on-demand': 'On demand' };

/** The agent's own setting, else the workspace default. */
export const effectiveToolAccess = (own: ToolAccess | null | undefined, workspace: ToolAccess | undefined): ToolAccess => own ?? workspace ?? 'auto';

/** Enabled third-party tools (tools that are not off) of the agent's connectors view. */
export function thirdPartyToolCount(list: readonly AgentConnector[]): number {
	let n = 0;
	for (const c of list) {
		if (c.source === 'builtin' || !c.enabled) continue;
		for (const cap of c.capabilities) n += cap.toolModes.filter((t) => t.mode !== 'off').length;
	}
	return n;
}

/** Whether the model has to search for the tools (given the mode and the number of third-party tools). */
export const isOnDemand = (access: ToolAccess, tools: number): boolean => access === 'on-demand' || tools >= AUTO_THRESHOLD;

/** One-line explanation under the control. `tools` is omitted where the count is not known. */
export function toolAccessHint(access: ToolAccess, tools?: number): string {
	if (access === 'on-demand') return 'The model searches for connector tools when it needs one: fewer tokens per message, one extra step for the first use.';
	if (tools !== undefined && tools >= AUTO_THRESHOLD) return `Auto: this agent has ${tools} connector tools, so they are found on demand.`;
	return `Auto: connector tools load up front, and switch to on demand at ${AUTO_THRESHOLD} or more.`;
}
