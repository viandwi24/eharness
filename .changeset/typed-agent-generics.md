---
"eharness": patch
---

`NoticePayload.code` accepts app-defined strings (library codes still autocomplete), so `session.inject('eh.notice', { code: 'MY_CODE', ... })` type-checks without a cast. The showcase apps no longer cast `HarnessAgent` / `HarnessSession`: the agent and session generics already flow.
