/**
 * `eharness/group`: the `groupChat()` plugin and `routeGroupMessage()` — should-respond gating
 * (mention, reply, patterns, custom hook), a pending history of gated-out messages, speaker
 * metadata and a bot-to-bot anti-loop for multi-party chats.
 *
 * @see docs/specs/16-group-plugin.md
 */
export {
  type GroupAuthor,
  type GroupChatOptions,
  type GroupChatPlugin,
  type GroupDecision,
  type GroupIgnoreReason,
  type GroupMessage,
  type GroupMessageData,
  type GroupRouteResult,
  type GroupSession,
  groupChat,
  routeGroupMessage,
} from './plugin.ts'
export { GROUP_HISTORY_PREAMBLE, GROUP_SPEAKER_PREFIX } from './texts.ts'
