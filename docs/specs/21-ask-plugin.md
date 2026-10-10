# Spec 21 — Ask plugin (`eharness/ask`)

Status: **Draft (0.7)**. Module: `src/ask/*`. Built only with the public core API (ADR-0008).
Design principle: ADR-0034 (every module works in three deployment profiles).

`askUser(options)` adds `ask_user_question`, a multiple-choice question tool. The model asks 1–4
questions with 2–4 options each; the answers come back as the tool result.

## 1. API

```ts
import { askUser, formatAnswers, answerOutput, pendingQuestions, parseQuestions, ASK_TOOL } from 'eharness/ask'

askUser({
  toolName?: string                    // 'ask_user_question'
  maxQuestions?: number                // 4 (1..4)
  interactive?: boolean | ((ctx: HarnessContext) => boolean)   // true
  whenNoHuman?: 'dismiss' | 'error' | ((questions: Question[]) => QuestionResult | Promise<QuestionResult>)   // 'dismiss'
}): HarnessPlugin<'ask'>

interface Question { question: string; header: string /* ≤ 12 */; options: { label: string; description?: string }[] /* 2..4 */; multiSelect: boolean }
interface Answer { selected?: string[]; other?: string; notes?: string }
type QuestionResult = { answers: Answer[] } | null        // null = dismissed

formatAnswers(questions, result): string
parseQuestions(input, { toolName?, maxQuestions? }): { questions } | { error }
pendingQuestions(pending, { toolName?, maxQuestions?, storedInputs? }): PendingQuestion[]
answerOutput(call: PendingQuestion, result: QuestionResult, note?): { toolCallId, output } | { toolCallId, errorText }
```

## 2. The tool

- Input `{ questions: Question[] }`, validated by the zod schema above. The description tells the
  model: when to ask, that "Other" and notes are always offered (it must not add "Other"), to put
  the recommended option first, and not to use the tool for approvals (the approval system does
  that).
- Metadata: none (a question is not a risk). It is a **session tool** (resolved once per session).

## 3. Profiles

| Profile | Configuration | Behaviour |
|---|---|---|
| (a) autonomous server, no human | `interactive: false` (+ `whenNoHuman`) | the tool has an `execute` and returns the fallback in the same step; the turn never stops |
| (b) single-process CLI | default | client tool (no `execute`): the turn stops `'tool-pending'`; the app asks the user in process and calls `respond({ toolOutputs })` |
| (c) split web/server | default | same stop; the pending state goes to the browser (`result.pending` or the `tool-pending` stream part), the browser answers and the app calls `respond({ toolOutputs })` (spec 11 §6, §7) |

`interactive` is evaluated **once per session** at tool resolution (a client tool cannot become an
executed tool mid-session). Use `(ctx) => ctx.runtime.human === true` to pick per session from the
developer runtime context.

Fallback (`whenNoHuman`):

- `'dismiss'` — the result is the dismissed text of `formatAnswers(q, null)`; the model proceeds
  with its best judgment.
- `'error'` — `ERROR: no user is available to answer questions. Decide yourself and state your assumption.`
- function — returns the answers (or `null`); a throw becomes an `ERROR:` text.

## 4. Formatting (model-visible, stable)

```
The user answered:
- <header>: <label>, <label>; other: "<text>"
  notes: <notes>
```

An unanswered question reads `(no answer)`. `null` reads `The user dismissed the questions without
answering. Proceed with your best judgment or ask in plain text.` Changing any of this text is a
minor change.

## 5. Pending helpers

`pendingQuestions(pending)` reads `PendingState.clientTools` (spec 11 §2), keeps calls of the tool,
and parses `input`. When the input was left out (`inputTruncated`, > 16 KB), the caller may pass it
in `storedInputs` (from the stored message part); otherwise that call becomes an error entry.
Invalid input yields an error entry with text the model can correct itself from
(`Invalid ask_user_question input: questions.0.header: …`). `answerOutput` turns an entry and the
user's result into the `toolOutputs` entry of `respond()`; an error entry answers with `errorText`.
Every pending call must be answered (spec 11 §6).

## 6. Errors

None thrown for expected failures. Programmer errors (invalid options) are not validated beyond
clamping `maxQuestions` to 1..4.
