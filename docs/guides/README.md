# Guides

Task-oriented walkthroughs. The contracts behind them are in [`../specs`](../specs); runnable code
is in [`../../examples`](../../examples) (every example runs offline with `bun examples/<file>`).

| Guide | You will learn |
|---|---|
| [Getting started](getting-started.md) | install, a first agent, run it on Node or Bun, offline testing |
| [Writing a plugin](writing-a-plugin.md) | `definePlugin`: tools, services, hooks, state, data parts |
| [Writing a storage adapter](writing-a-storage-adapter.md) | `MessageAdapter`, `StateAdapter`, `SessionLock`, conformance tests |
| [Rendering data parts](rendering-data-parts.md) | custom UI data: persistent vs transient, kinds, typed rendering |
| [Skills](skills.md) | static skills, `SKILL.md` folders, custom skill sources |
| [Approvals and interaction](approvals-and-interaction.md) | tool approval, client tools, regenerate/edit, steer, queue, wake |
| [Subagents](subagents.md) | a tool that runs a child session with live progress and usage |
