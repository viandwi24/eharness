---
"eharness": minor
---

`eharness/providers`: presets for local model servers — `ollamaProvider`, `lmStudioProvider`,
`vllmProvider` and `llamaCppProvider` (OpenAI-compatible, no API key needed, the usual local
address as default). Their model lists carry the context window the server really runs each model
with (Ollama `/api/ps` and Modelfile `num_ctx`, LM Studio's loaded instance, vLLM `max_model_len`,
llama.cpp `n_ctx`), tools/vision/thinking support where the server reports it, and a zero price.
`openAICompatibleProvider` gains an optional `contextWindow` setting for servers that report none,
reads vLLM's `max_model_len`, and a preset's `defaultBaseURL` now applies when the field is empty.
