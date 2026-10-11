# ADR-0015: Long turns are bounded by progress, not by small counts

Status: **Accepted** · Date: 2026-09-30

## Context

0.1 capped a turn at 50 steps, 100k output tokens and 3 forced continuations. Coding agents that
work unattended for hours (opencode, Codex CLI, Claude Code, checked 2026-09-30) have no small step
cap: opencode's `agent.steps` defaults to unlimited, Codex's turn loop has none, Claude Code's
`maxTurns` and `maxBudgetUsd` default to none. What keeps them from spinning is progress-based:
opencode's doom-loop check (3 identical calls), Codex's goal loop that blocks after 3 empty automatic
turns, Claude Code's Stop-hook override after 8 blocks without progress, OpenHands' stuck detector.
Fixed counts either stop real work (a 9-hour build hits 50 steps in minutes) or let a stuck model
burn the whole budget.

## Decision

- `loop.maxSteps` defaults to 500; `maxTurnOutputTokens` and `maxContinues` default to none.
- When the step budget still runs out, one **wrap-up** step without tools asks for a summary
  (`loop.wrapUp`, default on), like opencode's last step.
- A **progress guard** (spec 05 §3.2) keys every tool call by (tool, input, output). The same key 3
  times in the last 20 tool steps, or 5 steps in a row whose calls all failed, is "stuck": one
  volatile reminder, then stop `'stuck'`. Including the output avoids flagging legitimate polling
  whose result changes.
- `turn.beforeEnd` continuations are refused after `loop.maxIdleContinues` (3) continuations in a
  row that produced no new successful tool result; hooks see `idleContinues`.

## Consequences

+ Long autonomous turns work with default settings; stuck turns end early with a clear reason.
+ Continuation plugins (todos, goals) cannot loop forever without doing anything.
− Changed defaults (0.x minor): apps that relied on 50 steps / 100k tokens must set them.
− A model that makes "new" calls without real progress is not caught; budgets (ADR-0016) are the
  backstop.

## Alternatives considered

- Keep fixed counts, raise them (rejected: still wrong in both directions).
- LLM judge for progress (deferred: a future goal plugin can add one on `turn.beforeEnd`).

## Amendment note (2026-10-11)

Bounded waits (0.8, P39): progress bounds the loop, and every `await` the core makes is bounded in time as well. Plugin hooks are raced against the turn abort signal and `hooks.timeoutMs` (default 30 000; `W_HOOK_TIMEOUT`; `input.submit` and `tool.approve` stay fail-closed), model streams get a default idle timeout (`settings.timeout` `firstChunkMs` / `chunkMs`, 120 000) and `maxRetries: 2`, tool sources are listed concurrently with `toolSources.timeoutMs` and a backoff (`toolSources.retryAfterMs`) for a failing source, and MCP and OAuth requests have default limits. Background children are bounded by default (`background.timeoutMs` one hour, `stopOnTimeout: true`).
