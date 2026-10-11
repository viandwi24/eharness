---
"eharness": minor
---

**BREAKING:** `localSandbox` no longer passes the whole `process.env` to commands. A command inherits only an allow-list (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, plus the usual Windows variables; exported as `SAFE_ENV_NAMES`), so provider keys and database URLs of the host process do not reach commands the model writes. Migration: add what a project needs through `localSandbox({ root, env })`, or pass `inheritEnv: true` for the old behaviour. The `examples/coder` CLI now adds git, package-manager and proxy variables explicitly. `bash_output` `filter` and `notify_on` now accept only the safe regex subset of the `grep` tool (no quantified groups, one variable quantifier) and test only the first 2 000 characters of a line, so a pattern from the model cannot freeze the process (ReDoS); an unsafe pattern is returned to the model as an error string.
