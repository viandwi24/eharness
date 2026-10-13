# sandbox-server

A standalone **remote code sandbox** for `eharness/code` (spec 28). It runs in Docker, listens on a
port, and an eharness app connects with a URL and a token. Each session is a disposable
`scratchSandbox` (a temp directory, `ulimit` limits, OS sandbox without network when the
container allows it). The server has no database and no state worth keeping: files live in the
app's virtual file system, the sandbox is a cache.

## Run

```bash
# from the repository root
docker build -f examples/sandbox-server/Dockerfile -t eharness-sandbox-server .
docker run -d --name sandbox -p 4100:4100 -e SANDBOX_TOKEN=change-me-please \
  --read-only --tmpfs /tmp:size=1g,mode=1777 --memory 4g --cpus 2 --pids-limit 512 \
  eharness-sandbox-server
curl localhost:4100/healthz
curl -H 'authorization: Bearer change-me-please' localhost:4100/v1/info
```

Without Docker: `SANDBOX_TOKEN=change-me-please PYTHON=python3 bun examples/sandbox-server/src/main.ts`
(Bun and Python on the machine; the OS sandbox is used when present).

`docker-compose.example.yml` shows the team example next to a sandbox on an `internal` network
(no internet egress for scripts), with memory/CPU/pids limits, read-only root and a tmpfs.

## Use from an app

```ts
import { code } from 'eharness/code'
import { probeRemoteSandbox, remoteSandbox } from '@eharness-examples/sandbox-server/client'

const info = await probeRemoteSandbox({ url, token }) // connection test: info or a readable Error
code({
  sandbox: () => remoteSandbox({ url, token }), // one session per agent session; dispose() deletes it
  python: { command: info.pythonCommand }, // /opt/eh-python/bin/python in the image
  requireIsolation: true, // the server declares isolation { isolated: true }
})
```

`remoteSandbox` implements every AI SDK `Experimental_SandboxSession` method over `fetch` only
(runtime-neutral). `readTextFile` line ranges are applied client-side.

## Protocol `/v1`

All endpoints except `/healthz` need `Authorization: Bearer <SANDBOX_TOKEN>` (constant-time
compare; 401 otherwise). Errors are `{ "error": "..." }`.

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | `{ ok: true }`, no auth |
| `GET /v1/info` | `{ version: 1, python, pythonCommand, packages: [[name, version]], isolation: { isolated: true, label: "sandbox-server container" }, limits }` |
| `POST /v1/sessions` | `201 { id }` (128-bit hex). `429` at `SANDBOX_MAX_SESSIONS` |
| `DELETE /v1/sessions/:id` | `204`; kills running commands, removes the directory |
| `GET /v1/sessions/:id/files?path=` | file bytes; `404 file not found` when missing |
| `PUT /v1/sessions/:id/files?path=` | body = bytes, `204`; `413` over `SANDBOX_MAX_FILE_MB` |
| `POST /v1/sessions/:id/run` | body `{ command, workingDirectory?, env?, timeoutMs? }`, response NDJSON |

Paths are relative to the session directory: absolute paths, `..` segments and NUL are `400`. File
operations never follow a symlink at the final component or leave the root (a symlink planted by a
script is refused with `400`), by `localSandbox`'s guard.

`run` streams one JSON object per line: `{"start":true}` (headers flush, ignore), then any number of
`{"stdout":"..."}` / `{"stderr":"..."}` (UTF-8 text), and finally `{"exit": n}`. If the client
aborts the request the process group is killed. `timeoutMs` is capped by `SANDBOX_TIMEOUT_MS`; on
timeout the process is killed and a stderr note is added (exit 137).

Idle sessions (no request, no running command) are disposed after `SANDBOX_IDLE_MINUTES`. Stale
scratch directories are removed at start. One log line per request: method, path, status, time (no
token, no query string).

## Configuration

| Variable | Default | |
|---|---|---|
| `SANDBOX_TOKEN` | required, 8+ chars | bearer token |
| `PORT` / `HOST` | 4100 / 0.0.0.0 | |
| `SANDBOX_DATA` | `/tmp/eh-sandboxes` | parent of session directories (use a tmpfs) |
| `PYTHON` | `python3` (image: `/opt/eh-python/bin/python`) | probe interpreter, put first on `PATH` of commands |
| `SANDBOX_CPU_SECONDS` | 120 | `ulimit -t` per command |
| `SANDBOX_MEMORY_MB` | 1024 | `ulimit -v` per command (Linux) |
| `SANDBOX_FILE_MB` | 64 | `ulimit -f`, largest file a command writes |
| `SANDBOX_PROCESSES` | 128 | `ulimit -u` |
| `SANDBOX_TIMEOUT_MS` | 300000 | wall clock per command |
| `SANDBOX_MAX_FILE_MB` | 64 | largest upload/download through the API |
| `SANDBOX_MAX_SESSIONS` | 32 | |
| `SANDBOX_IDLE_MINUTES` | 30 | |
| `SANDBOX_OS` | auto | `off` skips the bubblewrap probe |

## Isolation notes

- The container is the boundary. Run it with `--read-only`, a tmpfs for `/tmp`, `--cap-drop ALL`,
  memory/cpu/pids limits, and on a network without internet egress (compose: `internal: true`).
  The OS sandbox (bubblewrap, no network) is probed at start and used only if the container allows
  user namespaces; otherwise the log says so and the container alone isolates.
- Commands see only a safe subset of the environment (not `SANDBOX_TOKEN`), but a script runs as
  the same user as the server, so it can read the server process's environment through `/proc`.
  The token only grants more sandbox sessions inside the same container; do not reuse it elsewhere.
- Packages come from `requirements.txt` at image build; there is no install endpoint (no
  network for scripts). Edit the list and rebuild to change the toolbox.

## Tests

`bun test examples/sandbox-server` starts the server in-process (Python 3 needed for the run tests)
and covers auth, the file/run round trip, path and symlink refusal, limits, TTL, and `code()`
`run_python` over `remoteSandbox`.
