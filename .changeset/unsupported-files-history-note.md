---
"eharness": patch
---

A file the model cannot take no longer breaks a session. Projection replaces a stored file part whose modality the current model lacks (`ModelInfo.inputModalities` known) with a short text note, for `data:` URLs and library references and for steers, without changing storage, so a session recovers after a model switch and an old image cannot fail every later turn. Input nobody waits on (`enqueue`, including `collect`, and steers) is accepted whole instead of being refused or failing at the provider: the text is kept and the model sees the note. `send()` and `edit()` still refuse a new unsupported file with `EH_INVALID_INPUT`.

Text-like attachments (`text/*`, JSON, XML, YAML) with known bytes are now projected as text parts (a header line with name, type and size, then the content, cut at 100 000 characters) instead of file parts, which some upstreams reject.
