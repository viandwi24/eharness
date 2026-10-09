---
"eharness": minor
---

New subpaths `eharness/ask` and `eharness/web` (P31).

- **`eharness/ask`**: `askUser()` adds `ask_user_question` (1–4 multiple-choice questions). A client tool by default (answered with `respond({ toolOutputs })`); `interactive: false` with `whenNoHuman` (`'dismiss' | 'error' | fn`) makes it answer itself for autonomous servers. Helpers `formatAnswers`, `answerOutput`, `pendingQuestions`, `parseQuestions`.
- **`eharness/web`**: `webFetch()` (one URL to Markdown with allow/deny lists, private-address refusal, injectable `resolveHost`, redirect, byte and character caps, injectable `toMarkdown`) and `webSearch({ search })` (provider-agnostic). Both are `risk: 'external'`.
