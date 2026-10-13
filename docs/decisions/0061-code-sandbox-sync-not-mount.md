# ADR-0061: Code sandbox over the virtual file system: sync, not mount

Status: **Accepted** · Date: 2026-10-13 · Related: [ADR-0034](0034-deployment-profiles.md), [ADR-0036](0036-node-only-modules.md), [ADR-0008](0008-plugins-adapters-dogfooding.md) · Plan: [P44](../plans/P44-code-sandbox.md)

## Context

Agents need to run code (Python first) over files: write data, write a script, run it, read the
outputs. The eharness file system is virtual (spec 08: `read`, `write`, `list`, `delete` with
content versions, backed by memory, a database or object storage), while interpreters need a real
directory. The shell plugin already runs commands through AI SDK's `Experimental_SandboxSession`
(`run`, `spawn`, `readFile`, `writeFile`), and the team example's `run_code` copies declared inputs
into a scratch directory and copies outputs back, which works but copies everything on every run
and is JavaScript only.

Options considered:

1. **Mount the store** (FUSE, a custom Emscripten file system, ZenFS). FUSE needs privileges and is
   not portable to hosted sandboxes; Emscripten file system operations are synchronous while our
   stores are async (a database or S3 cannot be read synchronously without blocking a worker on
   `Atomics.wait`); the Emscripten JS file system is planned to be replaced by WasmFS; the ZenFS
   Emscripten bridge describes itself as not extensively tested.
2. **Run in-process** (Pyodide, QuickJS, `node:vm`, isolated-vm, WASI). `node:vm` and WASI preopens
   are documented as not being security mechanisms; Pyodide code can reach JavaScript, and a
   Pyodide-based runner for untrusted Python has been retired for that reason; memory exhaustion
   reaches the host process. Useful for convenience, not as the boundary.
3. **Watch the directory** (inotify-style events). Racy and incomplete.
4. **Sync around each run.** Copy in before, list and copy back after. This is how hosted code
   execution products separate the file store from the execution environment (upload before the
   run, collect generated files after it, the container is disposable).

## Decision

- **Sync, not mount.** The virtual file system is the source of truth; the sandbox's work
  directory is a per-session cache. Before a run the mounted prefixes are synced in; after it the
  sandbox lists its files and the changes are written back.
- **Incremental by content.** A per-session manifest records `fsVersion` and `sandboxHash` per
  path. Sync-in uploads only changed versions (listing returns versions without content); sync-out
  downloads only changed hashes; deletions are detected by the diff, without a watcher. The
  sandbox computes its own listing (one helper command), so no hashing runs in the host process.
- **Compare-and-set write-back** with the versions seen at sync-in; a concurrent edit becomes a
  `CONFLICT:` result, never a silent overwrite. Nothing is written back after a failed run by
  default.
- **Same policy as the file tools** (hidden, read-only, undeletable, extensions, permission rules,
  an application access hook), exposed by the filesystem plugin as a `filePolicy` service.
- **The bridge is itself a `SandboxSession`** (`syncedSandbox()`), so the shell plugin can later run
  on a virtual workspace without changes; isolation remains the driver's property (local OS
  sandbox, container, microVM), and drivers for hosted sandboxes stay examples (ADR-0008).
- **Packages: the environment is a cache, the requirement list is data.** A base environment is
  built once from a developer-owned list (or is the container image) and keyed by its content
  hash; extra packages are opt-in, approved, installed by the plugin (not by model code) with
  wheels only, and the accepted list is stored in the virtual file system so any fresh sandbox can
  rebuild it. Scripts have no network.
- **The sandbox is disposable.** Nothing lives only in it: changes are written back at the end of
  every run, the manifest is never persisted, a missing work directory or environment is rebuilt
  (files by a full sync-in, extra packages from the stored list), and no volume is required.
- New subpath `eharness/code`, runtime-neutral (it talks to the sandbox only through the AI SDK
  type), importing core only through `src/index.ts`.

## Consequences

- Works with any `FileSystem` adapter and any `SandboxSession` driver; no new runtime dependency.
- The first run over a large tree pays a full copy (bounded by caps, reported when skipped); later
  runs pay only for changes.
- Scripts see a snapshot: files changed in the virtual file system during a run are not visible to
  it, and the run's own changes become visible only after it ends.
- `localSandbox` needs read isolation (`denyRead`) before it is reasonable for agent-written code
  on a server; until then the guide recommends a container driver for untrusted code.
