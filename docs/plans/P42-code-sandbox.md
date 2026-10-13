# P42 — Code sandbox over the virtual file system (`eharness/code`, Python first)

Status: todo · Owner: maintainer (CTO mandate) · Branch: `main` (batched, see release workflow)

## Goal

An agent can run **Python** over the files it works with, in an isolated environment, without
passing data through tool arguments: it writes `/work/sales.csv`, writes `/work/analyze.py`, calls
`run_python({ file: '/work/analyze.py' })`, and the files the script creates or changes
(`/work/report.md`, `/work/chart.png`) appear in the same virtual file system, where `read_file`,
the UI and other agents see them. The file system stays virtual (memory, database, S3; spec 08):
the sandbox is a **cache that is synchronised around every run**, never the source of truth.
Execution goes through AI SDK's `Experimental_SandboxSession`, so the same code runs on
`localSandbox` (development, self-hosting) and on any container or microVM driver (production,
untrusted code). In the connector UI this is one connector, **Files & Sandbox**: file management
plus running code.

Design and the options that were rejected: [ADR-0061](../decisions/0061-code-sandbox-sync-not-mount.md).

## Specs

- New: `docs/specs/28-code-plugin.md` (written in phase A of this plan, before code).
- `docs/specs/08-filesystem-plugin.md` §1 (contract, `version`), §2 (policy options), §12 (binary).
- `docs/specs/19-shell-plugin.md` §6 (local sandbox, OS profiles; gains `denyRead`).
- `docs/specs/24-connectors.md` §8 (built-in `files` connector gains code capabilities).
- `docs/specs/18-permissions-plugin.md` (path rules applied to sync-in and write-back).

## Owns

- `src/code/**` (new subpath `eharness/code`, runtime-neutral, imports core only via
  `src/index.ts`, ADR-0008; listed in CLAUDE.md hard rule 4 and `scripts/check-imports.ts`).
- `src/shell/os-sandbox.ts`, `src/shell/sandbox-local.ts` (`denyRead`, resource limits).
- `src/connectors/builtin.ts` (code capabilities of `files`).
- `src/filesystem/plugin.ts` (the `filePolicy` service only).
- `docs/specs/28-code-plugin.md`, ADR-0061, `docs/guides/code-sandbox.md`.
- `examples/team/**` parts listed in phase F; `examples/sandboxes/**` (driver examples, not published).

## Decisions (CTO)

- **D1 — Sync, not mount.** Before a run the plugin copies the mounted part of the virtual file
  system into the sandbox's work directory; after the run it lists the work directory and writes
  back what was created, changed or deleted. No FUSE, no custom Emscripten file system, no
  watcher (ADR-0061 lists why). A store with only `read`/`write`/`list` is enough.
- **D2 — A warm work directory per session, with a sync manifest.** The manifest maps every synced
  path to `{ fsVersion, sandboxHash }`. Sync-in uploads only paths whose `fsVersion` differs from
  the manifest (the `list` call returns versions without content, so unchanged files cost
  nothing); sync-out downloads only paths whose hash differs. A second run over the same data
  uploads zero files. The manifest is in memory (the work directory is a cache: a lost one is
  rebuilt by a full sync-in).
- **D3 — The sandbox lists its own files.** After a run one helper command (an embedded Python
  script run with the configured interpreter; later a POSIX `find … -exec cksum` fallback for
  non-Python runtimes) prints `path, size, sha1` as JSON. The baseline is the same listing taken
  after sync-in, so no hashing code is needed in JavaScript and odd file names are safe. A driver
  may offer a faster `list` (an in-process driver); the plugin uses it when present.
- **D4 — Write-back is compare-and-set.** Every write uses `ifVersion` = the version seen at
  sync-in (`null` for new files). A file changed in the virtual file system during the run is
  **not** overwritten: the result says `CONFLICT: /work/x.csv changed while the code ran; the
  sandbox copy was not saved`. By default nothing is written back when the run failed (exit code
  ≠ 0, timeout, abort): `writeBack: 'success' | 'always'`, default `'success'`.
- **D5 — The same rules as the file tools.** Hidden prefixes are never copied in; read-only
  prefixes are copied in but never written back; `isUndeletable` and `allowedExtensions` hold on
  write-back; permission rules (spec 18) and an application `access` hook (the team's program
  authority) decide per path. The filesystem plugin exposes its policy as a `filePolicy` service so
  the code plugin does not duplicate the options.
- **D6 — Paths.** The sandbox work directory mirrors the virtual root: `/work/sales.csv` is
  `work/sales.csv` relative to the current directory, which is the work directory. The tool
  description says so, and a `FileNotFoundError` for an absolute path under a mount gets the hint
  `(use the relative path work/sales.csv)`. Only the configured `mounts` are synced (default
  `[{ virtual: '/work/' }]`; a mount can be `readonly: true`, e.g. `/data/`).
- **D7 — Python only in this phase.** One tool `run_python({ file?, code?, args?, timeoutSeconds? })`:
  either a file of the virtual file system (preferred; the description says "write the script with
  write_file, then run it") or inline `code` for one-liners (not saved). JavaScript and a
  `bash` over the synced workspace come later on the same bridge (`syncedSandbox()` returns a
  `SandboxSession`, so `shell()` can run on it unchanged). The team example's JavaScript
  `run_code` stays as it is until then.
- **D8 — Packages: the environment is a cache, the requirement list is data.** See the next
  section.
- **D9 — Isolation is the driver's job, and the result says which one ran.** `localSandbox` with
  the OS sandbox (no network, writes only in the work directory, **new: `denyRead`** for the home
  directory and listed paths, CPU/file-size limits) is for development and trusted agents; a
  container or microVM driver (Docker, E2B, Vercel Sandbox, Daytona; examples only, rule 5) is for
  untrusted code. In-process WASM (Pyodide) is an example driver labelled "not a security
  boundary". `requireIsolation: true` refuses to run without an OS sandbox or a driver that
  declares itself isolated.
- **D10 — No preset wrappers** (docs over presets): the library ships no package list; the guide
  and the team example ship a recommended list, a lock file and a Dockerfile.

## Packages: how libraries get into the sandbox

Three layers, from most to least preferred. The model learns which packages exist from the tool
description (stable, cached per environment) and from the hint on `ModuleNotFoundError`.

1. **Base environment (preinstalled, immutable).** The developer decides it once: a container
   image, or for `localSandbox` a virtual environment built from a requirements/lock file at first
   use. It lives **outside** the synced work directory (never copied to the virtual file system)
   and is keyed by `hash(interpreter version + sorted requirement lines)`, so a changed list builds
   a new environment and an unchanged one is reused across sessions and restarts. The guide's
   recommended list for data work: `numpy`, `pandas`, `matplotlib`, `openpyxl`, `pyarrow`,
   `python-dateutil`, `tabulate`, `pillow`, `pypdf`, `beautifulsoup4`, `lxml`, `scipy` (the team
   example's Dockerfile and lock file pin versions). At session tool resolution the plugin probes
   the environment once (`importlib.metadata`, cached by the environment key) and appends
   `Python 3.x. Installed packages: pandas 2.x, …` (top-level names, at most 60, sorted) to the tool
   description; it changes only when the environment changes (prompt-cache prefix, spec 02 §5).
2. **Extra packages per workspace (opt-in, approved).** `packages.install: 'off' | 'allowlist' |
   'any'`, default `'off'`. When on, a second tool `install_packages({ packages })` (risk
   `'external'`, its own connector capability, default mode `ask`) installs into a workspace
   environment layered on the base (`venv --system-site-packages` over the base, or `uv` when
   present, which reuses its global cache). The install is run **by the plugin, not by model
   code**, through a separate `installer` sandbox session that has network (only for the install)
   and may write only the environment directory, with `--only-binary=:all:` (wheels only: no
   `setup.py` build scripts run at install time) and an optional private index URL. `allowlist`
   checks names (and optional version ranges) before anything runs. The accepted extra list is
   **stored in the virtual file system** (`/work/.eharness/requirements.txt`, read-only for the
   file tools), so it survives restarts and moves between drivers: a fresh sandbox rebuilds the
   workspace environment from it. Extras are reported in tool results, not in the description.
3. **Nothing installed at run time by the script.** Network is off during `run_python`; `pip
   install` inside the script fails. The `ModuleNotFoundError` hint says either `x is not
   installed; use install_packages` (install on) or `x is not available here; use the standard
   library or an installed package: …` (install off).

Containers: the base layer is the image; `install_packages` needs a driver that can run the
installer with network (a second session or a driver option). A driver that cannot do that runs
with `install: 'off'`.

## Scope

- In: `eharness/code` (sync bridge, manifest, `run_python`, `install_packages`, environment
  probe and cache key, `ModuleNotFoundError`/path hints), `filePolicy` service, `localSandbox`
  `denyRead` and limits, `files` connector capabilities, binary write-back, spec 28, guide, team
  example adoption, a Docker driver example and a Pyodide driver example.
- Out (later phases): JavaScript runtime, `bash` over the synced workspace, Jupyter-style kernels
  that keep state between calls, GPU, long-running background scripts, live file sync during a
  run, a hosted-sandbox adapter shipped inside the library (rule 5).

## Phase A — Spec and ADR

- [ ] ADR-0061 accepted (status from Proposed to Accepted after review of this plan).
- [ ] `docs/specs/28-code-plugin.md`: API (`code({ sandbox, mounts, python, packages, limits,
      writeBack, access, requireIsolation })`, `syncedSandbox()`), tool texts and every result
      format (model-visible, api-stability), sync algorithm (D2–D4), manifest rules, conflict and
      skip reporting, limits, ignore list, environment key and probe, install policy, events.
- [ ] Spec 08: `filePolicy` service. Spec 19: `denyRead`, `limits`. Spec 24: code capabilities.
- [ ] CLAUDE.md layout and hard rule 4 list `src/code/**`; `scripts/check-imports.ts` updated.

## Phase B — Sync bridge (`syncedSandbox`)

- [ ] Manifest and sync-in: `list(mount)` → upload changed versions (`writeBinaryFile` for binary,
      `writeTextFile` for text), delete sandbox files whose virtual file is gone, caps
      (`maxSyncFiles` default 2 000, `maxSyncBytes` default 200 MB, `maxFileBytes` default 50 MB);
      skipped files are reported, never silently dropped.
- [ ] Listing helper (embedded Python, JSON out, sha1) and the driver `list` fast path.
- [ ] Sync-out: diff against the baseline → new / changed / deleted; compare-and-set writes;
      binary through `writeBytes` (adapter without bytes: binary outputs are listed as not saved);
      default ignore list `__pycache__/`, `*.pyc`, `.ipynb_checkpoints/`, `.eharness/env*`;
      `PYTHONDONTWRITEBYTECODE=1`.
- [ ] Policy on both directions (D5) through `filePolicy`, permissions and `access`.
- [ ] One run per session at a time (mutex); the work directory is removed at session close;
      leftovers of a crashed process are removed on the next start (local driver).
- [ ] Tests with an in-memory fake driver: zero uploads on the second run, conflict, failed run saves
      nothing, deletion propagation, hidden and read-only prefixes, caps, binary, odd file names.

## Phase C — `run_python` and environments

- [ ] Tool `run_python`: `file` or `code`, `args`, `timeoutSeconds` (default 60, max 300); runs
      `python -E -s <file>` in the work directory with `MPLBACKEND=Agg`, `HOME` = scratch, the
      stripped environment; output capped like `bash` (spec 19 §2); result footer lists saved,
      deleted, conflicting and skipped files.
- [ ] Hints: `ModuleNotFoundError` (installed list or `install_packages`), absolute-path
      `FileNotFoundError` (D6), OS sandbox denials (as `bash` does).
- [ ] Environment: base build from a requirements list for `localSandbox` (venv; `uv` when found),
      key, probe (`importlib.metadata`), description line, cache directory option.
- [ ] `install_packages` with `installer` session, `--only-binary=:all:`, allowlist, index URL,
      the stored extra list and rebuild from it.
- [ ] Tests: scripted model over the fake driver; real `localSandbox` runs where `python3` exists
      (skipped otherwise), including pandas only when the test environment has it.

## Phase D — Local isolation

- [ ] `localSandbox({ os: { denyRead } })`: Seatbelt `(deny file-read* (subpath …))` and bubblewrap
      `--tmpfs` over denied directories; default denies the home directory except the work and
      environment directories. Closes the open item recorded in P40.
- [ ] `limits`: CPU seconds and file size (`ulimit -t`, `ulimit -f`), memory (`ulimit -v`, Linux
      only; documented as not enforced on macOS), process count where supported.
- [ ] Tests on both profiles (argv/profile generation; real runs where the tool exists).

## Phase E — Connector

- [ ] Built-in `files` connector: when `files.code` is configured, capabilities `run`
      ("Run Python", `run_python`, default `ask`) and `install` ("Install packages",
      `install_packages`, default `ask`, only with `install` ≠ `'off'`). Name via `labels`
      (the team sets "Files & Sandbox").
- [ ] Activation: the code plugin is installed only with at least one code capability on; file
      capabilities alone behave exactly as today.

## Phase F — Team example and docs

- [ ] Team: `Files & Sandbox` label; `run_python` under the program authority (`access` hook);
      a Dockerfile and lock file with the recommended packages; env `TEAM_CODE_DRIVER=local|docker`.
- [ ] `examples/sandboxes/docker` (a `SandboxSession` over `docker exec`) and
      `examples/sandboxes/pyodide` (in-process, not a security boundary).
- [ ] Guide `docs/guides/code-sandbox.md`: drivers and isolation table, packages, sizing,
      the CSV → script → report walkthrough; production checklist entry.
- [ ] Changeset (`minor`), board, exports snapshot.

## Acceptance criteria

- [ ] Scenario (team, real `localSandbox`): the agent writes `/work/sales.csv` and
      `/work/analyze.py` (pandas + matplotlib), runs it, and `/work/report.md` and
      `/work/chart.png` are in the virtual file system (database-backed) and `read_file` shows the
      chart as an image.
- [ ] A second run over unchanged data uploads 0 files (measured in the test).
- [ ] An edit of `/work/sales.csv` by another session during a run produces `CONFLICT:` and keeps
      the virtual file intact; a failed run writes nothing back.
- [ ] A hidden file is never present in the sandbox; a write under a read-only mount is reported
      and not saved.
- [ ] With `denyRead`, the script cannot read the server's database file or `~/.ssh`.
- [ ] `import scipy` without scipy: the hint names the installed packages (install off) or
      `install_packages` (install on, approved, then the import works in the next run and after a
      server restart).
- [ ] `bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports` green
- [ ] Changeset added; specs updated

## Open questions

- Should `install_packages` without a wheel fall back to source builds when the developer allows
  it (`allowSourceBuilds`)? Conservative default meanwhile: no.
- Size of the probed package list in the description: top-level names only (default) or with
  versions? Meanwhile: names with major.minor versions, at most 60.
- Should the manifest be persisted (plugin state) so a restarted process with a surviving work
  directory skips the full sync-in? Meanwhile: no; a restart does a full sync-in.

## Requests to other phases

- P40: the `os.denyRead` item in its open list is closed by phase D here.
