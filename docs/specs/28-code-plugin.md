# Spec 28 — Code plugin (`eharness/code`)

Status: **Draft (0.9)**. Module: `src/code/*`. Runtime-neutral (Web APIs only; it reaches the
sandbox only through AI SDK's `Experimental_SandboxSession`). Built only with the public core API
(ADR-0008). Design: [ADR-0061](../decisions/0061-code-sandbox-sync-not-mount.md). Plan:
[P44](../plans/P44-code-sandbox.md).

`code()` lets an agent run **Python** over the files of the virtual file system (spec 08). The
virtual file system is the source of truth; the sandbox's directory is a per-session cache that is
synchronised around every run (sync-in before, sync-out after). The sandbox is disposable: it may
disappear at any moment and nothing is lost that was saved at the end of a run.

## 1. API

```ts
import { code, syncedSandbox } from 'eharness/code'
import type { Experimental_SandboxSession as Sandbox } from 'ai'

code({
  /** One sandbox per session. Its root (relative paths) is the session's work directory. */
  sandbox: CodeSandbox | ((ctx: HarnessContext) => CodeSandbox | Promise<CodeSandbox>)
  /** Prefixes of the virtual file system that are synced. Default [{ virtual: '/work/' }]. */
  mounts?: Array<{ virtual: string; readonly?: boolean }>
  python?: {
    /** Interpreter inside the sandbox when no environment is built. ONE executable (name or path, quoted as a whole, no arguments). Default 'python3'. */
    command?: string
    /** Build a base environment from these requirement lines (needs `envRoot` and `installer`). */
    requirements?: string[]
    /** Absolute directory inside the sandbox where environments are kept (outside the work directory). */
    envRoot?: string
  }
  packages?: {
    install?: 'off' | 'allowlist' | 'any'           // default 'off'
    allow?: string[]                                 // for 'allowlist': names, optional specifier
    indexUrl?: string                                // private index (pip --index-url)
    listPath?: string                                // default '<first writable mount>.eharness/requirements.txt'
  }
  /** Sandbox used to build environments: network on, writes only under `envRoot`. */
  installer?: Sandbox | ((ctx: HarnessContext) => Sandbox | Promise<Sandbox>)
  limits?: Partial<CodeLimits>
  writeBack?: 'success' | 'always'                   // default 'success'
  sync?: boolean                                     // default true; false: files are already on the sandbox's disk (§4.6)
  ignore?: string[]                                  // glob patterns of paths never written back; default §4.4
  /** Application authority per path (e.g. a program's read/write globs). Default: everything allowed. */
  access?: (path: string, op: 'read' | 'write' | 'delete', ctx: HarnessContext) => boolean | Promise<boolean>
  /** Refuse to run when the sandbox does not declare isolation (§6). Default false. */
  requireIsolation?: boolean
  risk?: ToolRisk                                    // default 'write' on an isolated sandbox (§6), else 'external'
  installRisk?: ToolRisk                             // default 'external'
}): HarnessPlugin<'code'>

interface CodeSandbox extends Sandbox {
  /** Called at session close (remove a scratch directory, stop a container). */
  dispose?(): Promise<void>
  /** Optional: what isolation the driver gives. `localSandbox` exposes `state()` instead. */
  isolation?: { isolated: boolean; label: string }
  /** Optional fast path for sync-out: files under `dir` (`work` or `.`) with sha1; paths relative to the root (`work/a.csv`). */
  listFiles?(dir: string): Promise<Array<{ path: string; size: number; sha1: string }>>
}

interface CodeLimits {
  timeoutMs: number        // default 60_000
  maxTimeoutMs: number     // default 300_000
  maxOutputChars: number   // default 30_000 (head + tail, as `bash`)
  maxSyncFiles: number     // default 2_000 files per mount set
  maxSyncBytes: number     // default 200 MiB per sync-in
  maxFileBytes: number     // default 50 MiB per file (in and out)
  maxWriteBackFiles: number // default 500
}

syncedSandbox(options: {
  fs: FileSystem; sandbox: Sandbox; mounts: Mount[]; limits?; ignore?; policy?: FilePolicyLike;
  access?: (path, op) => boolean | Promise<boolean>; listCommand?: string
}): SyncedSandbox     // §4; the bridge without the tools (used by `code()`, usable by other plugins)
```

Plugin: name `code`, `requires: ['fs']` (it must come after `filesystem()`), no data parts, no
instructions (the tool descriptions carry the text), service `codeSandbox` (§7). Tools in this
order: `run_python`, then `install_packages` (only when `packages.install !== 'off'`). Invalid
options throw `EH_CONFIG_INVALID` from `code()`: a mount that does not start and end with `/`,
overlapping mounts, `install !== 'off'` without `installer` or `envRoot`, `requirements` without
`envRoot` and `installer`, `install !== 'off'` without a writable mount (or `listPath`),
`install: 'allowlist'` without `allow`, a non-positive limit.

Exports: `code`, `syncedSandbox`, `RUN_PYTHON_TOOL` (`'run_python'`), `INSTALL_PACKAGES_TOOL`
(`'install_packages'`), `DEFAULT_CODE_LIMITS`, `DEFAULT_CODE_IGNORE`, `parseRequirement` and the
types. Texts and the helper scripts are internal.

## 2. Paths

- The sandbox root is the work directory. The virtual path `/work/sales.csv` is the sandbox path
  `work/sales.csv` (the leading `/` dropped). Commands run with the root as current directory, so
  scripts use relative paths. A mount `/` is allowed (the whole tree is synced).
- `.eh-code/` at the root is reserved (helper scripts, the marker file, §4.5); it is never synced
  and a mount may not map onto it.
- Names that cannot round-trip (a `\n` in a name, a path `normalizePath` rejects) are skipped on
  sync-out and listed as not saved.

## 3. Tools (model-visible; text changes are a minor change)

### `run_python`

Input: `{ file?: string, code?: string, args?: string[], timeoutSeconds?: number }`. Exactly one of
`file` / `code` (both or none: `ERROR: give either file or code.`). `file` is a virtual path under a
mount (`ERROR: <path> is not under a synced folder (<mounts>).`, missing:
`ERROR: <path> does not exist.`). `code` is written to `.eh-code/inline.py` and never saved.
`timeoutSeconds` is capped at `maxTimeoutMs`.

Description: the text in `src/code/texts.ts` with the mounts, the timeout, the relative-path rule
and the environment line filled in:
`Python <x.y.z>. Installed packages: <name> <major.minor>, … (at most 60, sorted by name; "and <n>
more" after that).` When the probe failed: `Python environment: <command> (packages unknown).` The
description is computed when the session's tools are resolved and cached per environment key, so
it changes only when the environment changes (prompt-cache prefix, spec 02 §5). It recommends
writing the script with `write_file` and running it with `file`.

Run: sync-in (§4.2), then the interpreter (§5) runs `-E -s -B -u ./<script> <args…>` (the script is always passed as `./<path>` so a name that starts with `-` is never an option; `-B` and `-u`
because `-E` ignores the matching environment variables, which are passed too) in the root with the
environment `PYTHONDONTWRITEBYTECODE=1`, `MPLBACKEND=Agg`, `PYTHONUNBUFFERED=1`,
and an **absolute** `HOME` (`HOME="$PWD/.eh-code/home"`, the directory is created first), plus what the driver adds; then sync-out (§4.3). One run per session at a time
(a second call waits for the first).

Result (always a string, never a throw):

```
<stdout and stderr interleaved, capped like bash>
Exit code <n> · <s>s
Saved: /work/report.md, /work/chart.png
Deleted: /work/old.csv
Not saved: /work/x.csv (changed in the file system while the code ran)
Not copied in: /work/huge.parquet (larger than 50 MB)
```

Lines after the footer appear only when non-empty; each list shows at most 20 paths then
`… and <n> more`. Reasons (exact texts): `changed in the file system while the code ran`,
`read-only`, `not allowed`, `cannot be deleted`, `extension not allowed`, `binary files are not
supported by this file system`, `larger than <n> MB`, `too many files changed (limit <n>)`,
`file name not supported`, `too many files (limit <n>)` and `over the sync size limit (<n> MB)`
(not copied in, caps of §4.2), `the run failed` (only with `writeBack: 'success'`, as one line:
`Not saved (the run failed): <n> changed files.`).

Other outcomes: timeout `(timed out after <n>s)` replaces the exit code part of the footer;
abort `(aborted after <s>s)`; the sandbox died or could not run the command:
`ERROR: the sandbox stopped during the run; nothing was saved. (<message>)`. With
`requireIsolation` and no isolation: `ERROR: running code needs an isolated sandbox, and this one
is not (<label>).` A rebuilt environment adds a first line `Rebuilt the package environment (<n>
packages, <s>s).`

Hints appended before the footer:
- `ModuleNotFoundError: No module named 'x'` →
  install off: `(x is not installed. Installed packages: <list>. Use the standard library or one of them.)`;
  install on: `(x is not installed. Use install_packages to add it.)`
- `FileNotFoundError` naming an absolute path under a mount (`/work/a.csv`) →
  `(Paths are relative to the sandbox root: use work/a.csv.)`
- the sandbox's OS denial texts → the same hint `bash` appends (spec 19 §2).

### `install_packages` (only with `packages.install !== 'off'`)

Input `{ packages: string[] }` (1–20 requirement lines: a name and an optional version specifier,
`parseRequirement`; no URLs, paths, options or `-r`). `metadata.risk` = `installRisk`. Steps:
validate every line (`parseRequirement`: a name, an optional version specifier; extras, markers,
URLs and options are rejected) (`ERROR: "<line>" is not a package name with an optional version.`), check the
allowlist (an entry without a specifier allows any version; an entry with one requires exactly
that specifier) (`REJECTED: <name> is not on the list of allowed packages.`), merge with the stored list
(§5.2), build the workspace environment with the installer, write the list. Result:
`Installed: pandas-ta 0.3, … (<s>s). They can be imported in the next run_python call.` or
`ERROR: installing failed: <last 2 000 characters of the installer output>` (the stored list is
unchanged on failure).

## 4. Sync

### 4.1 Manifest

Per session, in memory, never persisted: `Map<virtualPath, { fsVersion, sha1, size }>` plus the
marker id (§4.5). Lost (restart) or invalid (marker mismatch) → empty, and the next sync-in is a
full one. The manifest describes the sandbox's files as of the last sync.

### 4.2 Sync-in

1. Marker check (§4.5); a mismatch also wipes the mount directories in the sandbox, like a dirty bridge.
2. For every mount: `fs.list(mount.virtual)` (metadata only). Hidden paths (`filePolicy`, §7) and
   paths `access(path, 'read')` refuses are excluded. Files over `maxFileBytes` are excluded and
   reported (`Not copied in`). When the mount set exceeds `maxSyncFiles` / `maxSyncBytes` the files
   beyond the cap (sorted by path) are excluded and reported.
3. Upload every included path whose `fsVersion` differs from the manifest (or is absent): binary
   (`FileMeta.binary`) through `readBytes` + `writeBinaryFile`, text through `read` +
   `writeTextFile`. A file read as `null` (deleted in between) is treated as absent.
4. Before anything is uploaded every symlink under the mount directories is removed inside the
   sandbox (`find <dirs> -type l -delete`, quoted): a symlink is never syncable, and a script may
   have planted one that points out of the root (the host-side writes must not follow it).
5. Paths in the manifest that are no longer included (deleted in the file system, now hidden or
   refused) are removed in the sandbox (`rm -f` through `run`, batched) and from the manifest.
6. The baseline for sync-out is the manifest after this step; uploaded files get the sandbox's sha1
   from one listing (§4.3 step 1) restricted to the uploaded paths, so no hashing runs on the host.

A second run over unchanged files uploads nothing.

### 4.3 Sync-out

1. List the sandbox files under every mount: `listFiles` when the driver has it, else the embedded
   helper (`.eh-code/list.py`, run as `<python> -I list.py list-args.json`; prints one JSON array of
   `{ path, size, sha1 }`, skips the ignore patterns, symlinks, hard-linked files (`st_nlink > 1`)
   and anything that is not a regular file, using `lstat`). `.eh-code/` is writable by scripts, so
   the helper and its arguments are **rewritten before every listing**, never only on a marker
   mismatch, and run isolated (`-I`). The rows are untrusted: the host side must not follow
   symlinks when it reads a file back (see §6, driver requirement). A failing listing after a
   successful run is reported as `ERROR: listing the sandbox files failed; nothing was saved.
   (<message>)`.
2. Diff against the baseline: new (not in the manifest), changed (sha1 differs), deleted (in the
   manifest, missing now). Ignored paths (§4.4) are never written back.
3. With `writeBack: 'success'` and a failed run (non-zero exit, timeout, abort, sandbox error):
   stop here; report the count; the manifest keeps the baseline values (the sandbox now differs,
   so the next sync-in re-uploads what the run changed: the marker is not touched, the changed and
   deleted paths are dropped from the manifest, and files the run created are removed from the
   sandbox so a later successful run does not save them).
4. For each path (sorted, at most `maxWriteBackFiles`): policy (`readonly` mount, `filePolicy`
   read-only / extension / undeletable, `access(path, 'write' | 'delete')`), then
   compare-and-set: write with `ifVersion` = the manifest's `fsVersion` (`null` for a new path);
   delete with `ifVersion`. Bytes that are valid UTF-8 (`looksBinary` false) are written as text;
   other bytes through `writeBytes` with `detectMediaType` (no `writeBytes`: not saved, reason
   `binary files are not supported…`). A conflict or `exists` result is not saved (reason
   `changed in the file system while the code ran`) and the path is dropped from the manifest so
   the next sync-in brings the file system's version back. An error while saving one file (a file
   system or sandbox failure) is caught per file and reported as `could not be saved: <message>`;
   the other files are still written, and the report never claims that nothing was saved after a
   write happened. The same holds for every path that is
   not saved for another reason (read-only, not allowed, …). `packages.listPath` is never written
   back (`not allowed`): a script cannot change the stored requirement list.
5. The manifest takes the new `fsVersion` and sha1 of every saved path.

### 4.4 Ignore list

`DEFAULT_CODE_IGNORE`: `**/__pycache__/**`, `**/*.pyc`, `**/.ipynb_checkpoints/**`,
`**/.DS_Store`. `ignore` replaces it. Patterns use the glob syntax of spec 08 §3 against the
virtual path.

### 4.5 Disposable sandbox

The first sync of a session writes `.eh-code/marker` with a random id and keeps it in the manifest.
Every sync-in reads it (`readTextFile`): missing or different (the directory was wiped, the
container restarted, another instance) → the manifest is cleared, a new marker written, and the
sync-in is full. A failed removal of files in step 5 of §4.2 marks the bridge dirty too. After a sandbox error during a run (§3) the bridge is marked dirty: the next
sync-in removes the mount directories in the sandbox (`rm -rf`; for a `/` mount everything at the root except `.eh-code/`: `find . -mindepth 1 -maxdepth 1 ! -name .eh-code -exec rm -rf {} +`) and uploads
everything. The base environment and the workspace environment are probed the same way
(§5.3). No volume is required; the result of a run that was in flight when the sandbox died is
`ERROR: the sandbox stopped during the run; nothing was saved.`

### 4.6 `syncedSandbox()`

The bridge as a reusable object: `{ syncIn(): Promise<SyncInReport>; syncOut(ok: boolean):
Promise<SyncOutReport>; run(command, opts): Promise<…>; manifest(): ReadonlyMap<…> }`. `code()`
uses it. The identity case (the file system is a disk adapter whose root is the sandbox root) is
not detected automatically: the application passes `sync: false` to `code()`, and the tool then
runs the script directly on the files (no manifest, no write-back reports).

## 5. Environments

### 5.1 Base interpreter

- No `requirements`: the base interpreter is `python.command` (a container image with its
  packages, or the host's `python3`).
- `requirements`: the plugin builds `<envRoot>/base-<key>` with the installer the first time it is
  needed (the first `run_python`, reported as a rebuild; never at session open) (`<command> -I -m venv <dir>`, then `<dir>/bin/python -I -m pip install --only-binary=:all:
  [--index-url <url>] <lines…>`; `uv venv` + `uv pip install` when `uv` is on the installer's PATH).
  `key` = first 16 hex of SHA-1 over `<python version>\n<sorted requirement lines>`. An existing
  directory with a `.eh-ok` file is reused (built by an earlier session or process); building
  writes `.eh-ok` last, so a half-built environment is rebuilt. Every installer command runs with
  `envRoot` as its working directory (`mkdir -p` + `cd`) and every Python call uses `-I`, so files
  of the work directory cannot be picked up. The installer's own root must therefore not be the
  work directory (it is a separate sandbox, or at least a different directory). All interpreter
  paths (`python.command`, environment interpreters) are shell-quoted as one executable.

### 5.2 Extra packages (workspace environment)

- The accepted extra lines are stored in the virtual file system at `packages.listPath`
  (default: `<first writable mount>.eharness/requirements.txt`), one line each, sorted. The
  application should list the directory in the filesystem plugin's `readonlyPrefixes` so the model
  cannot edit it with the file tools; with `install: 'any'` and a writable list the plugin logs a
  warning at session open. On every rebuild the lines are validated again (`parseRequirement`, the
  allowlist).
- The workspace environment is `<envRoot>/ws-<key>` (key over the base key and the extra lines):
  `<base python> -I -m venv --system-site-packages <dir>`, a `.pth` file in its site-packages that
  points at the base environment's site-packages (when the base is itself a venv), then the extras
  installed as in §5.1. `run_python` uses it when the stored list is non-empty.
- `run_python` with a stored list whose environment is missing (`.eh-ok` absent) rebuilds it
  before the run and reports it (§3). A failed rebuild runs nothing: `ERROR: rebuilding the package
  environment failed: <tail>`.

### 5.3 Probe

`<python> -I -c <probe>` prints `{ version, packages: [[name, version], …] }` from
`importlib.metadata`. Cached per environment key (plugin instance, process lifetime). Only an environment that is
already built is probed for the description (otherwise `packages unknown`). Used for the
description (§3) and the `ModuleNotFoundError` hint.

## 6. Isolation

The plugin never claims isolation it does not get. Isolated when: the sandbox has `state()` (the
local sandbox) with `enabled: true` and `network: false`, or `isolation.isolated === true`. The
`codeSandbox` service reports it (§7). `requireIsolation: true` refuses runs otherwise (§3). The
installer is never used for model code.

**Driver requirement (symlinks).** The sandbox's file operations (`readBinaryFile`,
`writeBinaryFile`, …) are used by the bridge with paths a script influenced. A driver must not
follow symlinks out of the root: `localSandbox` resolves the nearest existing ancestor with
`realpath`, refuses a path outside the root (or `allowWrite`) and refuses a symlink at the final
component (spec 19 §6); other drivers must give the same guarantee. The bridge removes symlinks
before sync-in and the lister skips them, as defence in depth.

## 7. Service `codeSandbox` and the `filePolicy` service

```ts
interface CodeSandboxService {
  status(): Promise<{ python?: string; driver: string; isolated: boolean; install: 'off' | 'allowlist' | 'any'; extras: string[] }>
  /** Drop the manifest (next sync-in is full). */
  reset(): void
}
```

`filePolicy` is provided by the filesystem plugin (spec 08 §2) and read from `ctx.services` when
present (a missing service means no policy):

```ts
interface FilePolicy {
  isHidden(path: string): boolean
  isReadonly(path: string): boolean
  extensionAllowed(path: string): boolean
  isUndeletable(path: string): boolean
}
```

## 8. Errors

No new error codes. Expected failures are `ERROR:` / `REJECTED:` strings (§3). A sandbox factory
that throws fails the session open. `dispose()` errors are logged (`ctx.log.warn`).

## 9. Tests

`src/code/*.test.ts` with an in-memory fake driver (a `Sandbox` over a `Map`, a scripted `run`):
zero uploads on the second run, conflict, failed run saves nothing, deletions both ways, hidden and
read-only prefixes, `access`, caps and reports, binary, odd names, a wiped root (marker) between
two runs, a sandbox that dies mid-run, the hints, the description and its stability, the
installer flow and the lazy rebuild, `requireIsolation`. Real `localSandbox` runs when `python3`
exists (skipped otherwise).
