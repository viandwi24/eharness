# Chunked work: process big data without filling the context

When an agent has to look at thousands of items (chat messages, tickets, log lines) the answer is
never "read them all". This guide describes the pattern the team example uses for its community
auditor, in terms any eharness harness can copy. It needs no new library API: files, a code runner
and a checkpoint file.

```
source --collect--> files --pre-filter(code)--> candidate chunks --map(model)--> findings
                                                    ^                               |
                                            manifest (resume)             reduce(code) --> report
```

## 1. Collect: deterministic, no model

Put the source behind one tiny interface and write what it returns to files:

```ts
interface Collector {
  id: string
  poll(cursor: string | null): Promise<{ items: Array<{ id: string; channel: string; at: number }>; cursor: string | null }>
}
```

Append items to `data/<source>/<channel>/<YYYY-MM-DD>/<HH>.jsonl` (hourly files keep every file
small and make "one day" a directory). Store the cursor next to them. Make it safe to repeat:
write the files first, move the cursor last, and skip an item whose id is already in the file. A
crash then repeats a page and never duplicates data. Telegram, Slack or a database is one more
`Collector`; the rest of the pipeline does not change.

## 2. Pre-filter with code, not with the model

The model is the expensive, slow part: let code decide what deserves its attention. Give the agent a
tool that runs JavaScript over files (the team example's `run_code`, a Bun subprocess in an OS
sandbox: no network, writes only in a scratch directory, time and output limits) and tell it to
print summaries, never raw data. Typical filters: links by domain, bursts (many items by one author
in a few minutes), waves of new members, keywords, moderator and admin actions. The code writes
the candidates as **chunk files of a fixed small size** (about 6 KB, so a chunk is read in full).
A day of 5 000 messages (800 KB) became 218 candidates in 9 chunks.

Decide authority before the code runs, not inside it: copy into the sandbox only the paths the run
may read, and copy back only the paths it may write (use the same rule matcher as your permission
engine, so deny rules and amendments apply). Treat what the code writes as untrusted until it is
checked.

## 3. Map: one chunk at a time, with a manifest

`work/<run>/manifest.json`:

```json
{ "run": "community-audit-2026-10-11", "cursor": { "lastDone": "003" },
  "chunks": [ { "id": "001", "status": "done", "findings": "work/.../findings/001.json" },
              { "id": "004", "status": "pending", "paths": ["work/.../chunks/004.jsonl"] } ] }
```

- One run id per job **and day**, so a later run finds the same manifest.
- Start every run by reading it. If it exists, resume: do not plan again.
- A chunk is `done` only when its findings file exists and parses. Marking is compare-and-set on the
  file version, so parallel workers can mark at once.
- A failed chunk is retried a bounded number of times, then left failed and reported.
- The model reads one chunk, writes `findings/<chunk>.json` (a fixed shape: severity, kind, summary,
  evidence ids, actors), marks it. For independent chunks you may hand batches to background
  subagents with a concurrency cap; they share the manifest.

A run that is killed (a timeout, a crash, a deploy) loses at most the chunk it was on.

## 4. Reduce with code, report with the model

A second code run merges the findings (counts by kind and severity, top actors), writes
`merged.json` and prints the top lines. The model writes the report from that, with evidence ids
and what it did not check (failed chunks, how many items were scanned). Severe findings leave the
run as a decision for a person (in the team example the `escalate` tool parks the run on the
Decision Center until the client answers).

## 5. Keep the context honest

- Never `read_file` the raw data; tool results of the pipeline are summaries.
- Raise the step limit of unattended runs: a chunked job is many small steps (the team example
  allows 150).
- Prove it in a test: with a scripted model, assert the biggest tool result and the number of raw
  items the model ever saw (see `examples/team/server/test/bigdata-audit.test.ts`), and test the
  kill-and-resume path by running the job twice on one database.
- Treat item text as data: a chat message can contain instructions aimed at the agent.

## Where it lives in the team example

| Piece | File |
|---|---|
| Collector, paths, merge | `examples/team/server/src/domain/collectors.ts` |
| Ingest, fixture day | `examples/team/server/src/infra/bigdata/ingest.ts`, `fixture-collector.ts` |
| Code runner | `examples/team/server/src/infra/bigdata/code-sandbox.ts` |
| Manifest | `examples/team/server/src/domain/manifest.ts` |
| Tools (one plugin) | `examples/team/server/src/infra/bigdata/plugin.ts` |
| The skill the agent reads | `examples/team/server/src/domain/builtin-skills.ts` |
| Walkthrough | [walkthrough-server.md, section 20](walkthrough-server.md#20-big-data-chunked-work) |
