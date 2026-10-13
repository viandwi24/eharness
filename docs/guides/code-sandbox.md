# Code sandbox: let the agent run Python over its files

`eharness/code` gives an agent a `run_python` tool. The agent writes data and a script into the
virtual file system, runs the script, and the files the script creates appear in the same file
system, where `read_file`, your UI and other agents see them. No data passes through tool arguments.
The contract is [spec 28](../specs/28-code-plugin.md); the design is
[ADR-0061](../decisions/0061-code-sandbox-sync-not-mount.md). The subpath is a **draft**: every
symbol may change in a minor release ([API stability](../engineering/api-stability.md)).

The one idea to keep in mind: **the virtual file system is the source of truth; the sandbox is a
disposable cache.** Before each run the plugin copies the synced folders into the sandbox's work
directory, after the run it copies back what changed. If the sandbox disappears, nothing is lost
that was saved at the end of a run.

## 1. A CSV, a script, a report

```ts
import { createAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { code } from 'eharness/code'
import { scratchSandbox } from 'eharness/shell'

const fs = memoryFs()

const agent = createAgent({
  model,
  plugins: [
    filesystem({ fs }),            // must come first: code() requires the `fs` service
    code({
      // one sandbox per session; scratchSandbox makes a temp directory and removes it on dispose()
      sandbox: () => scratchSandbox({ os: { enabled: true, denyReadHome: true } }),
      mounts: [{ virtual: '/work/' }],           // the default
      limits: { timeoutMs: 60_000 },
      requireIsolation: true,                    // refuse to run when the OS sandbox is not active
    }),
  ],
})
```

`code()` requires `filesystem()` (put it after). `scratchSandbox` and `localSandbox` live in
`eharness/shell` (Node only); `code()` itself is runtime-neutral and only sees the AI SDK
`Experimental_SandboxSession` type. With `requireIsolation: true` the example above works only
where the platform tool exists (macOS Seatbelt, Linux bubblewrap); elsewhere `run_python` returns an
error string instead of running unisolated.

A session might go like this (tool calls abbreviated):

```
user:   Summarise work/sales.csv by region and write a short report.

write_file({ path: '/work/sales.csv', content: 'region,amount\nnorth,120\nsouth,80\nnorth,40\n' })
write_file({ path: '/work/analyze.py', content: `
import csv, collections
totals = collections.Counter()
with open('work/sales.csv') as f:
    for row in csv.DictReader(f):
        totals[row['region']] += float(row['amount'])
with open('work/report.md', 'w') as out:
    out.write('# Sales by region\\n\\n')
    for region, total in totals.most_common():
        out.write(f'- {region}: {total:.2f}\\n')
print(dict(totals))
` })
run_python({ file: '/work/analyze.py' })
```

The result is always a string, never a throw:

```
{'north': 160.0, 'south': 80.0}
Exit code 0 · 0.1s
Saved: /work/report.md
```

Scripts use **relative** paths: the virtual path `/work/sales.csv` is `work/sales.csv` in the
sandbox, and commands run with the sandbox root as the current directory. (An absolute path in a
`FileNotFoundError` gets a hint: `Paths are relative to the sandbox root: use work/a.csv.`)

Everything after the `Exit code` line appears only when it applies:

```
Exit code 1 · 0.2s
Not saved (the run failed): 2 changed files.        <- default writeBack: 'success'

Exit code 0 · 0.3s
Saved: /work/report.md
Deleted: /work/old.csv
Not saved: /work/x.csv (changed in the file system while the code ran)   <- conflict
Not copied in: /work/huge.parquet (larger than 50 MB)
```

Other outcomes: `(timed out after 60s)` or `(aborted after 3.2s)` replace the exit code part, and
`ERROR: the sandbox stopped during the run; nothing was saved.` means the driver died. A failed
run saves nothing by default (`writeBack: 'success'`; `'always'` saves even then). You can pass the
script inline with `run_python({ code })`; it is written to `.eh-code/inline.py` and never saved. The
tool description recommends the file form (`write_file`, then `run_python({ file })`) because the
script stays in the workspace, reviewable and re-runnable.

## 2. How sync works

```
virtual file system  ──sync-in──▶  sandbox work directory  ──run──▶  sync-out  ──compare-and-set──▶  virtual file system
 (source of truth)    changed       (cache, per session)             list +                          write / delete with
                      versions                                       diff by sha1                     ifVersion = version seen at sync-in
```

- **Incremental.** A per-session manifest (in memory, never persisted) records each path's file
  system version and the sandbox's sha1. Sync-in uploads only paths whose version changed; a second
  run over unchanged files uploads nothing. Sync-out lists the sandbox once (a helper script, or the
  driver's `listFiles` fast path) and diffs: new, changed, deleted.
- **Compare-and-set write-back.** Each write or delete carries the version seen at sync-in. If the
  file changed in the virtual file system while the script ran, it is **not** overwritten: it is
  reported as `Not saved (... changed in the file system while the code ran)` and the next sync-in
  brings the file system's version back. A script sees a snapshot; its own changes become visible
  only after the run.
- **Same rules as the file tools.** Hidden paths are never copied in; read-only prefixes,
  disallowed extensions and undeletable paths are not written back; the optional `access(path, op,
  ctx)` hook adds your own authority (for example a program's read/write globs). These come from
  the `filePolicy` service of `filesystem()`.
- **Marker and full resync.** The first sync writes `.eh-code/marker`. If a later sync-in finds it
  missing or different (directory wiped, container restarted, another instance), the manifest is
  cleared and everything is uploaded again. After a sandbox error mid-run the bridge also resyncs
  from scratch.
- **Ignore list.** `**/__pycache__/**`, `**/*.pyc`, `**/.ipynb_checkpoints/**`, `**/.DS_Store`
  are never written back (`ignore` replaces the list). `.eh-code/` is reserved and never synced.
- **Caps.** Defaults: 2 000 files and 200 MiB per sync-in, 50 MiB per file, 500 changed files
  written back per run. Files beyond a cap are skipped and listed (`Not copied in`, `Not saved`),
  never silently dropped. Binary files need a file system with `writeBytes`.
- Runs are serialised per session: a second call waits for the first.

The bridge itself is exported as `syncedSandbox({ fs, sandbox, mounts, ... })`, a reusable object
(`syncIn`, `syncOut`, `run`, `manifest`) for plugins that want the same behaviour without the tools.

## 3. Drivers and isolation

`code()` does not run anything itself; the **driver** (an AI SDK `Experimental_SandboxSession`)
decides what the code can reach. The plugin never claims isolation it does not get: a driver counts
as isolated when it is a `localSandbox` with the OS sandbox active and network off, or when it
declares `isolation: { isolated: true, label }`. The `codeSandbox` service reports it
(`status()`), and `requireIsolation: true` makes `run_python` return
`ERROR: running code needs an isolated sandbox, and this one is not (<label>).` otherwise.

| Driver | Boundary | Use it for |
|---|---|---|
| `localSandbox` without the OS sandbox | none: the code runs with your user's privileges | throwaway local experiments only |
| `localSandbox` / `scratchSandbox` with `os: { enabled: true }`, `denyReadHome` or `denyRead`, and `limits` | Seatbelt / bubblewrap: writes only under the root, network off, chosen paths unreadable, `ulimit` limits. Defence in depth, not a jail ([shell guide](shell.md)) | development, trusted users, self-hosting where the host holds nothing secret |
| container (Docker driver: a `SandboxSession` over `docker exec`, like the team example's driver) | a real boundary for most uses: own filesystem, network off, CPU/memory limits, non-root | production for agent-written code |
| microVM hosted sandbox (Vercel Sandbox, E2B, Daytona, through any `Experimental_SandboxSession` implementation) | strongest isolation; also gives a disposable machine per session | untrusted code, multi-tenant products |
| in-process WASM such as Pyodide | **not a security boundary** (the code runs in your process and can reach JavaScript; memory exhaustion hits the host) | not shipped: build one yourself for convenience demos only |

The library ships only `localSandbox` and `scratchSandbox`; container and hosted drivers are
examples you copy and own ([ADR-0008](../decisions/0008-plugins-adapters-dogfooding.md)).

Two rules for any driver you write:

- **File operations must not follow symlinks out of the sandbox root.** A script can create a
  symlink to `/etc/passwd`, and the sync-out would read it through the driver's `readFile`. The
  bundled listing helper skips symlinks; your `readFile` / `writeFile` must stay under the root too
  (resolve and check, or run them inside the container).
- The OS sandbox of `localSandbox` covers commands, **not** the driver's own file operations (they
  run in your process). That is another reason a container is the default recommendation for
  untrusted code.

For a local sandbox on a server, set `denyReadHome: true` (or `denyRead: ['/etc/secrets', ...]`) so
the script cannot read your keys and config, and add `limits` (`cpuSeconds`, `fileBytes`,
`memoryBytes` on Linux only, `processes`). Details: [Shell, local sandbox](shell.md) and
[spec 19 §6](../specs/19-shell-plugin.md#6-local-sandbox).

## 4. Packages

Three layers, from cheapest to most flexible:

1. **The base environment.** Either the container image (python plus the packages you baked in, with
   `python.command` pointing at it) or an environment the plugin builds from
   `python.requirements` into `python.envRoot` with an `installer`. It is keyed by a hash of the
   Python version and the sorted requirement lines, built the first time it is needed (the first
   `run_python`, reported as `Rebuilt the package environment (<n> packages, <s>s).`), and reused
   by any later session or process that finds the same key.
2. **Extras through `install_packages`.** Off by default. With `packages.install: 'allowlist'` (and
   `allow: ['pandas', 'scipy>=1.11']`) or `'any'`, the model gets `install_packages({ packages })`.
   Lines are a name plus an optional version specifier only (no URLs, paths, options, extras or
   markers); an allowlist entry without a specifier allows any version. The plugin, not model code,
   runs the install with the **installer sandbox** (network on, writes only under `envRoot`), wheels
   only (`--only-binary=:all:`, so no `setup.py` runs), optionally from a private `indexUrl`. The
   model's own script never gets network or `pip`.
3. **The stored list.** Accepted extras are written to `packages.listPath` in the virtual file system
   (default `<first writable mount>.eharness/requirements.txt`). Any fresh sandbox rebuilds the
   workspace environment from it before the next run. Put that directory in the filesystem plugin's
   `readonlyPrefixes` so the model cannot edit it with file tools (with `install: 'any'` and a
   writable list the plugin logs a warning); scripts cannot write it back either.

```ts
code({
  sandbox: (ctx) => dockerSandbox({ image: 'my-python-data:2026-10', network: 'none' }),
  python: { requirements: ['pandas', 'numpy', 'matplotlib'], envRoot: '/opt/eh-envs' },
  installer: (ctx) => dockerSandbox({ image: 'my-python-data:2026-10', network: 'bridge' }),
  packages: { install: 'allowlist', allow: ['scipy', 'scikit-learn', 'openpyxl'] },
  requireIsolation: true,
})
// filesystem({ fs, readonlyPrefixes: ['/work/.eharness'] })
```

(`dockerSandbox` stands for your container driver; see section 3.)

A reasonable **data-work base list**: `pandas`, `numpy`, `matplotlib`, `openpyxl` (Excel),
`pyarrow` (parquet), `scipy`; add `scikit-learn` or `statsmodels` if analysis needs them. Keep it
small: the base environment is part of every cold start.

**How the model learns what is installed.** The `run_python` description carries a line
`Python 3.12.4. Installed packages: numpy 2.1, pandas 2.2, ... (at most 60, sorted; "and <n> more"
after that)`. It is probed once per environment and cached, so it changes only when the environment
changes and does not break the prompt-cache prefix. If the probe cannot run you get
`Python environment: <command> (packages unknown)`. On `ModuleNotFoundError` the result gets a hint:
with install off, `x is not installed. Installed packages: <list>. Use the standard library or one
of them.`; with install on, `x is not installed. Use install_packages to add it.`

## 5. The sandbox is disposable

You do not need a volume. Nothing lives only in the sandbox: results are written back at the end of
every run, the manifest is not persisted, and a missing work directory is simply repopulated.

If the container restarts or the scratch directory is wiped between two runs, the marker is gone,
the next `run_python` does a full sync-in (files come from the virtual file system) and, when the
environment directory is also gone, rebuilds the base environment and the extras from
`python.requirements` and the stored list. A run that was in flight when the sandbox died returns
`ERROR: the sandbox stopped during the run; nothing was saved.` and the next run starts clean.

The only thing worth persisting is a **pip/uv download cache** (a volume mounted at the installer's
cache directory). It makes a rebuild fast; it holds no state you need. `scratchSandbox` removes its
directory on `dispose()` (called at session close); `removeStaleScratch({ parent, prefix,
olderThanMs })` clears leftovers of crashed processes at boot.

## 6. As a connector

In a product where people enable capabilities per agent, code execution is a capability of the
built-in **Files** connector. The connector offers `run` (Run Python) and, with `install: true`,
`install` (Install packages). Run Python defaults to `allow` (an isolated sandbox has no network and its
only effect is files written back under the file policy, like `write_file`); Install packages
defaults to `ask` (it needs the network).

```ts
builtinConnectors({
  files: {
    plugin: ({ tools }) => [
      filesystem({ fs, tools: tools as FileToolName[] }),
      // the factory adds code() when run_python is among the enabled tools
      ...(tools.includes('run_python')
        ? [code({ sandbox, packages: { install: tools.includes('install_packages') ? 'allowlist' : 'off', allow } })]
        : []),
    ],
    code: { install: true },     // or `code: true` for run only
  },
})
```

The connector does not build `code()` for you; the factory decides (see
[Connectors](connectors.md) and [spec 24 §8](../specs/24-connectors.md)). Enabled capabilities map
to `input.tools` (`run_python`, `install_packages`), so turning `run` off removes the tool.

## 7. Coder-style workspaces on disk

When the file system already is a directory on the sandbox's disk (a coding agent over a project
checkout: `diskFs` with the same root as the sandbox), syncing is pure overhead. Pass
`sync: false`:

```ts
code({ sandbox: () => localSandbox({ root: cwd, os: { enabled: true } }), sync: false })
```

The script then runs directly on the files: no manifest, no copy, no write-back report. The plugin
does **not** detect this case automatically; you opt in. Conflicts, read-only prefixes and `access`
are no longer applied by the bridge, so rely on the OS sandbox and the permissions plugin.

## 8. Sizing, limits and a checklist

`limits` (all optional): `timeoutMs` 60 000, `maxTimeoutMs` 300 000 (the model's `timeoutSeconds`
is capped at it), `maxOutputChars` 30 000 (head and tail), `maxSyncFiles` 2 000, `maxSyncBytes`
200 MiB, `maxFileBytes` 50 MiB, `maxWriteBackFiles` 500. Raise the sync caps only if the first run
over a big tree is acceptable: it pays a full copy, later runs only the changes. Mount only what
scripts need (`mounts: [{ virtual: '/data/', readonly: true }, { virtual: '/work/' }]`); mounts must
start and end with `/` and may not overlap. Invalid options throw `EH_CONFIG_INVALID` at boot.

Checklist:

- [ ] The sandbox is a container or microVM for anything the model writes on a server; a local
      sandbox has the OS sandbox on, `denyReadHome` or `denyRead`, and `limits`.
- [ ] `requireIsolation: true` so a missing OS tool fails closed instead of running unisolated.
- [ ] Scripts have no network; only the installer does.
- [ ] `packages.install` is `'off'` or `'allowlist'`; the stored list directory is in
      `readonlyPrefixes`; `indexUrl` points to an index you trust.
- [ ] A custom driver's file operations stay under the root (no symlink escapes).
- [ ] `run_python` and `install_packages` have the risk and approval you want (`risk`, `installRisk`,
      default `external`; connector capabilities default to `ask`).
- [ ] `access` (or permission rules) restricts which paths a program may read and write.
- [ ] Sandboxes are disposed at session close; stale scratch directories are removed at boot.
- [ ] A test with a wiped sandbox between two runs and a concurrent edit (conflict) passes for your
      driver.
