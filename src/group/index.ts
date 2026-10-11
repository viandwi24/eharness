/**
 * `eharness/group`: the `group()` plugin and `routeGroupMessage()` — should-respond gating
 * (mention, reply, patterns, custom hook), a pending history of gated-out messages, speaker
 * metadata and a bot-to-bot anti-loop for multi-party chats.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/16-group-plugin.md
 */
export {
  type GroupAuthor,
  type GroupDecision,
  type GroupIgnoreReason,
  type GroupMessage,
  type GroupMessageData,
  type GroupOptions,
  type GroupPlugin,
  type GroupRouteResult,
  type GroupSession,
  group,
  routeGroupMessage,
} from './plugin.ts'
