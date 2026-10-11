# Ask the user (`eharness/ask`)

`ask()` gives the model `ask_user_question`: 1–4 multiple-choice questions, 2–4 options each,
single or `multiSelect`; "Other" and notes are always offered by the UI. Contract:
[spec 21](../specs/21-ask-plugin.md).

```ts
import { defineHarnessAgent } from 'eharness'
import { ask } from 'eharness/ask'

const model = 'anthropic/claude-sonnet-4.5' // yours: any AI SDK LanguageModel or model id
const agent = defineHarnessAgent({ model, plugins: [ask()] })
```

Options: `toolName` (default `ask_user_question`), `maxQuestions` (default and maximum 4),
`interactive` and `whenNoHuman` (below).

## Autonomous server (nobody to answer)

```ts
ask({ interactive: false })                                   // dismissed text; the model decides
ask({ interactive: false, whenNoHuman: 'error' })             // ERROR: no user is available…
ask({
  interactive: false,
  whenNoHuman: (questions) => ({                                  // a policy answer: first option
    answers: questions.map((q) => ({ selected: [q.options[0]!.label] })),
  }),
})
ask({ interactive: (ctx) => ctx.runtime.human === true })      // per session
```

The tool executes in the same step; the turn never stops.

## CLI and web: answer through the pending state

Default `ask()` is a client tool: the turn stops `tool-pending`. Read the questions, ask the
user, answer with `respond({ toolOutputs })`:

```ts
import { answerOutput, pendingQuestions } from 'eharness/ask'

// yours: session (agent.session(id)) and showDialog(questions) (your UI)
const result = await session.send('Set up the project').result
if (result.stop === 'tool-pending') {
  const calls = pendingQuestions(result.pending)            // [{ toolCallId, questions } | { toolCallId, error }]
  const toolOutputs = []
  for (const call of calls) {
    const answers = call.questions ? await showDialog(call.questions) : null   // { answers: Answer[] } | null
    toolOutputs.push(answerOutput(call, answers))
  }
  await session.respond({ toolOutputs }).result
}
```

In a split web/server app the same pending state is what the browser sees; it renders a dialog and
posts the answers back, and the server calls `respond({ toolOutputs })` (or `handleChatRequest`,
see [Approvals and interaction](approvals-and-interaction.md)). If the pending input was too large
(`inputTruncated`), pass `storedInputs` from the stored message part. A dismissed dialog is
`answerOutput(call, null)`; a timeout can add a note: `answerOutput(call, null, 'The question timed out.')`.
Answer every pending call, including other pending approvals, in the same `respond()`.
