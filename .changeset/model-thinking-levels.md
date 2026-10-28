---
"eharness": minor
---

`ModelInfo.thinking` tells which reasoning levels a model accepts (`levels`, `mandatory`,
`defaultLevel`; new types `ModelThinking` and `ThinkingLevel`): filled from OpenRouter's
`reasoning.supported_efforts` and from models.dev's `reasoning` flag. OpenRouter models now honour
the AI SDK `reasoning` call option (`settings.reasoning`), sent as OpenRouter's `reasoning.effort`.
