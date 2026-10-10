---
"eharness": minor
---

New subpath `eharness/ask`: `askUser()` adds `ask_user_question` (1–4 multiple-choice questions). It is a client tool by default (answered with `respond({ toolOutputs })`); `interactive: false` with `whenNoHuman` (`'dismiss' | 'error' | fn`) makes it answer itself for autonomous servers. Helpers: `formatAnswers`, `answerOutput`, `pendingQuestions`, `parseQuestions`, `ASK_TOOL`. See spec 21.
