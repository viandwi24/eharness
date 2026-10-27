/**
 * One plain model call with an agent's own model (P57): no tools, no session, no memory. Used for
 * jobs the owner starts and reviews (the memory reorganization proposal). It runs on the model the
 * owner picked for the agent, never a hidden premium fallback.
 */
import { generateText, type LanguageModel } from 'ai'
import type { AgentCompletion } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'

export function createAgentCompletion(deps: {
  agent: (id: string) => AgentDef | undefined
  model: (def: AgentDef) => LanguageModel
  /** Wrap the model of each call (the Logs page records it as a `job` of the agent). */
  observe?: (model: LanguageModel, agentId: string) => LanguageModel
}): AgentCompletion {
  return async (agentId, input) => {
    const def = deps.agent(agentId)
    if (def === undefined) throw new Error(`agent ${agentId} not found`)
    const model = deps.model(def)
    const result = await generateText({
      model: deps.observe?.(model, def.id) ?? model,
      instructions: input.system,
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens,
      maxRetries: 1,
    } as never)
    return result.text
  }
}
