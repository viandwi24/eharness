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
| `GET /v1/info` | `{ version: 1, python, pythonCommand, packages: [[name, version]], isolation: { isolated, label }, limits }` |
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
| `SANDBOX_UID_BASE` | 20000 | first uid of the per-session pool (size `SANDBOX_MAX_SESSIONS`) |
| `SANDBOX_OS` | auto | `off` skips the bubblewrap probe |

## Browser (`/v1/browser`, optional)

A managed Chrome (`chromeRuntime` of `eharness/browser/node`) on this server, driven by a remote
app through `remoteBrowserRuntime({ baseUrl, token })` from `src/client.ts` (a `BrowserRuntime`).
Off by default: build with `--build-arg SANDBOX_BROWSER_LIBS=1` (Chrome libraries, unzip, Xvfb)
and run with `SANDBOX_BROWSER=1`. Without it every `/v1/browser*` route answers 404.

| Route | |
|---|---|
| `GET /v1/browser/status` | `RuntimeStatus` (state, version, disk, install progress, running profiles) |
| `POST /v1/browser/install` | starts the download in the background, answers the status; poll `status` |
| `POST /v1/browser/start` `{ profileId, name?, settings? }` | `{ endpoint: { cdpPath, pid? } }` |
| `POST /v1/browser/stop` `{ profileId }` | 204 |
| `DELETE /v1/browser/profiles/{id}` | stops and removes the profile's data |
| `POST /v1/browser/uninstall` | removes the engine |
| `GET /v1/browser/usage?profileId=` | `{ usage: { rssBytes, cpuPercent } \| null }` |
| `GET /v1/browser/cdp/{profileId}` | WebSocket proxy to Chrome's CDP socket |

Chrome listens on `127.0.0.1` only; the proxy is the sole way in. The upgrade accepts the bearer
header or `?t=<signed token>` from `start` (HMAC with a per-boot key, valid for that profile for 10
minutes, checked when the socket opens): WebSocket clients cannot set headers in every runtime.
The URL is a credential, so it is never logged (the request log has no query string).

Caveat: code run by the code sandbox on the same host can reach loopback unless the OS sandbox
cuts the network, and a CDP socket is full control of a profile (logins). Enable the browser on a
server that does not run untrusted scripts, or keep `SANDBOX_OS` on with its network off. The
profile root (`SANDBOX_BROWSER_ROOT`) is created 0700. `SANDBOX_BROWSER_XVFB=1` runs headed Chrome
through `xvfb-run`.

## Isolation notes

- The container is the boundary. Run it with `--read-only`, a tmpfs for `/tmp`, `--cap-drop ALL`,
  memory/cpu/pids limits, and on a network without internet egress (compose: `internal: true`).
  The OS sandbox (bubblewrap, no network) is probed at start and used only if the container allows
  user namespaces; otherwise the log says so and the container alone isolates.
- **One Linux user per session.** The image runs the server as root on purpose. Each session gets
  a uid from a pool (`SANDBOX_UID_BASE`, default 20000, one per allowed session); its directory is
  `0700` and owned by that uid, files written through `PUT /files` are chowned to it, and every
  command runs through `setpriv --reuid --regid --clear-groups --no-new-privs`. A script of
  session A therefore cannot read or write session B's directory, and cannot read the server's
  environment (`/proc/1/environ` needs the same uid), so `SANDBOX_TOKEN` stays secret. On dispose
  every process of the uid is killed before the directory is removed and the uid is reused.
  Every process of the uid is also killed when a run ends (no background process survives a run),
  and `PUT /files` is refused with 409 while a command runs, so the server never writes into a
  directory a script can change at the same time.
  Commands also get only a safe environment (`inheritEnv` is off), never the server's variables.
- Root needs capabilities for this (compose: `cap_drop: ALL` plus `CHOWN SETUID SETGID KILL
  DAC_OVERRIDE FOWNER`). Not root (dev on macOS, a container started with `--user`)? The server
  logs `uid isolation off: sessions share one user ...`, and `/v1/info` reports
  `isolation: { isolated: false, label: "sandbox-server, shared user (not isolated between
  sessions)" }` (or `isolated: true` with an OS-sandbox label when bubblewrap works). The team's
  `requireIsolation` refuses such a server.
- The container is still the outer boundary. Run it with `--read-only`, a tmpfs for `/tmp`,
  memory/cpu/pids limits, and on a network without internet egress (compose: `internal: true`).
  The OS sandbox (bubblewrap, no network) is probed at start and used only if the container allows
  user namespaces; otherwise per-session users and the container isolate. All sessions still share
  the container's CPU, memory and network.
- Packages come from `requirements.txt` at image build; there is no install endpoint (no
  network for scripts). Edit the list and rebuild to change the toolbox.

## Tests

`bun test examples/sandbox-server` starts the server in-process (Python 3 needed for the run tests)
and covers auth, the file/run round trip, path and symlink refusal, limits, TTL, and `code()`
`run_python` over `remoteSandbox`.
