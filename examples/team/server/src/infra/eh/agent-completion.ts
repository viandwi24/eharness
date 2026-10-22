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
}): AgentCompletion {
  return async (agentId, input) => {
    const def = deps.agent(agentId)
    if (def === undefined) throw new Error(`agent ${agentId} not found`)
    const result = await generateText({
      model: deps.model(def),
      instructions: input.system,
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens,
      maxRetries: 1,
    } as never)
    return result.text
  }
}
