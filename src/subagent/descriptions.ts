/**
 * Model-facing descriptions and field texts of the subagent tools (kept stable per session:
 * prompt-cache prefix).
 */
import { AGENT_MESSAGE_INSTRUCTIONS } from './messaging.ts'
import type { SubagentDefinition } from './types.ts'

export const BACKGROUND_FIELD =
  'Start the subagent in the background and return at once; its report arrives later as an event. Use it for work you do not need before continuing.'
export const BACKGROUND_DEFAULT_FIELD =
  'Default true: the subagent runs in the background, the call returns at once and its report arrives later as an event. Set false only when you need the result before you can continue.'

function describeTypes(defs: Record<string, SubagentDefinition>): string {
  return Object.entries(defs)
    .map(([name, d]) => `- ${name}: ${d.description}`)
    .join('\n')
}

export const NAME_FIELD =
  'A short name (lowercase letters, digits, hyphens) so you can address this agent later with send_message'

export function messageDescription(name: string): string {
  return `Send a message to another agent of this session and keep working.

\`to\` is "main" (the agent that talks to the user, from a subagent), an agent id such as agent-2, a child session id, or the name you gave an agent.
- A running agent receives the message at its next step; nothing it is doing is interrupted.
- A finished agent is resumed on its own session, with its full history and your message as new input; its report arrives later like a background agent's report. One-shot agents that cannot be resumed refuse.
- Use ${name} to revise or extend an agent's work instead of stopping it and starting a new one.
- The receiver does not see your conversation: make the message self-contained, and do not repeat it.

${AGENT_MESSAGE_INSTRUCTIONS}`
}

export function toolDescription(
  defs: Record<string, SubagentDefinition>,
  messageTool?: string,
): string {
  return `Launch a subagent to handle a task on its own and return a report.

Available subagent types:
${describeTypes(defs)}

Usage:
- The subagent starts with no context: the prompt must be self-contained (goal, what you already know, the form of the answer you need).
- Only the subagent's final report comes back to you; it is not shown to the user.
- Launch independent subagents in parallel by calling this tool several times in one step.
- Do simple lookups yourself instead of launching a subagent.${
    messageTool === undefined
      ? ''
      : `
- Give an agent a \`name\` if you may want to follow up on it later: ${messageTool} reaches it by name or id, also after it finished (unless it is a one-shot type).`
  }`
}
