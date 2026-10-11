/** Session ids of the chats the server hosts. Row ids come from `uuidv7` (eharness). */

/** Session id of an agent's DM chat. */
export const dmSessionId = (agentId: string): string => `dm:${agentId}`

/** Session id of a delegated task. */
export const taskSessionId = (taskId: string): string => `task:${taskId}`

/** Session id of one routine fire. */
export const routineSessionId = (routineId: string, fireAt: number): string =>
  `routine:${routineId}:${fireAt}`
