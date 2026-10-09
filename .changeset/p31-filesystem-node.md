---
"eharness": minor
---

`eharness/filesystem/node` and file checkpoints (P31).

- **New subpath `eharness/filesystem/node`** (Node-only, ADR-0036): `diskFs(root, { readonly?, ignore?: { gitignore?, hidden? }, maxFileBytes?, grep? })` is a `FileSystem` over a real directory with `stat`, `grep` (ripgrep when on `PATH`, JavaScript fallback), `glob` and `move`; symlink-escape containment, a gitignore subset for hiding paths, mode-preserving atomic writes, compare-and-set under a per-path mutex, and readable errors for binary or oversized files. `mountFs(() => [{ virtual, fs, readonly? }])` composes file systems by longest prefix (a cross-mount move is not atomic). `nodeWorkspace({ root, extraDirs?, toolOutputsDir? })` builds the usual root + extra directories + tool-outputs workspace (`fs`, `mounts()`, `addDirectory`, `toReal`, `toVirtual`). `nodeCheckpointStore(dir)` is a JSON-file checkpoint store.
- **Checkpoints:** `filesystem({ checkpoints })` takes a `CheckpointStore` (`save`/`load`/`list`/`delete`) and records the content of a file before the first change of each turn (turn key: the id of the turn's user message, else the turn id). New exports from `eharness/filesystem`: `memoryCheckpointStore`, `rewindFiles`, `checkpointsSince`, `checkpointTurnKey`, `checkpointedFs` and the types. With the option set, the `fs` service and the file tools go through a recording wrapper; without it nothing changes.
