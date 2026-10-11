# Evals: scoring an agent against a fixed scenario

An eval answers "did my last prompt, skill or model change make the agent better or worse?" with
numbers instead of impressions. It runs a fixed **scenario** with a real model, scores the result,
and keeps the report so two runs can be compared. It is a developer tool: a CLI, no UI, never part
of CI or the unit tests.

The framework in [`examples/team/evals`](../../examples/team/evals) is an example, not library API.
It is built only on public pieces: `defineHarnessAgent`, the `filesystem()` plugin, the budget
ledger, and a structured-output grading call. Copy the folder and replace the scenarios.

## Run it

```bash
cd examples/team
export OPENROUTER_API_KEY=...            # or AI_GATEWAY_API_KEY
bun run eval community-audit --model anthropic/claude-sonnet-4.6 --budget 0.5 --repeat 2
bun run eval compare community-audit/<runA> community-audit/latest
bun run eval list
```

| Flag | Meaning |
|---|---|
| `--model <id>` | model under test (or `EVAL_MODEL`) |
| `--judge-model <id>` | model that grades rubrics (default: the same model; a cheaper one is fine) |
| `--budget <usd>` | hard cap for the whole invocation, agent and judge together. Default `1` |
| `--repeat <n>` | run the scenario `n` times (models are not deterministic); each run is its own report |
| `--price-in`, `--price-out` | USD per 1M tokens when the model is not in models.dev |
| `--allow-ci` | run although `CI` is set (refused otherwise) |

## Cost safety

- A run happens only when you start the CLI with a key in your environment. The test suite
  uses scripted models and never calls a real one.
- `--budget` is enforced twice: every model call reserves against a budget ledger scope
  (`budget.ledger`, so a call that cannot fit never starts) and `maxSessionUsd` stops the turn
  (`'cost-cap'`). Tasks that follow a used-up budget are skipped, rubric grading is skipped, the
  run is marked `budgetExceeded` and fails. A step in flight is never cut, so the final cost can
  exceed the cap by one step.
- Costs are catalog estimates (prices from `--price-*` or models.dev), not a bill.
- The CLI refuses to run when `CI` is set, unless `--allow-ci`.

## Write a scenario

A scenario is a folder `scenarios/<name>/` with `scenario.ts` (default export) and rubric files:

```ts
const scenario: Scenario = {
  name: 'research-queue',
  description: '...',
  dir: import.meta.dir,              // rubric files resolve against it
  instructions: 'You are a research assistant ...',  // the agent under test
  files: () => ({ '/queue/r1.md': '...', '/sources/a.md': '...' }),  // fixture workspace
  tasks: [{ id: 'r1', prompt: 'Research /queue/r1.md and write /out/r1.md' }],  // run in order,
                                                                                // one session each
  outputDir: '/out',                  // what counts as produced files (default /out)
  checks: [ /* deterministic */ ],
  rubrics: [{ id: 'quality', rubric: 'rubric.json', files: '/out/*.md', weight: 1 }],
  passThreshold: 0.7,
}
export default scenario
```

The agent works in an in-memory workspace through the file tools. The fixture can be anything you
can turn into files: a generated day of chat, a list of titles, research notes. Keep it
deterministic (seeded) so two runs see the same input.

### Deterministic checks

Pure code over the produced files: `run(ctx)` returns `{ score: 0..1, detail?, metrics? }`.
`ctx.outputs` are the files under `outputDir`, `ctx.files` the whole workspace, `ctx.tasks` the
per-task stop reason, steps and cost. Options: `weight`, `passAt` (default 1), `required` (a failed
required check fails the run whatever the total). Helpers in `src/helpers.ts`: `recallPrecision`
(ids against an answer key such as the fixture's planted incidents), `sectionCoverage` (required
Markdown headings), `parseJson`. Check what you can with code first: it is free, exact and stable.

### Rubric checks

For what code cannot judge (clarity, tone, grounding), a rubric file is plain JSON:

```json
{ "name": "Report quality", "passThreshold": 0.7,
  "criteria": [{ "id": "grounded", "description": "Findings follow from the cited sources.", "weight": 3 }] }
```

A judge model scores each criterion 0 to 5 with a one-line reason (structured output, temperature
0). The check score is the weighted mean divided by 5. The judge sees the task prompts and the
matching produced files, told to treat them as data. Eharness' `createJudge` decides tool-call
verdicts (allow / deny), so rubric grading is a separate, plain `generateText` call with an
`Output.object` schema. A judge failure fails that check, not the run. LLM scores are noisy: use
`--repeat` and compare averages, and keep rubrics few and concrete.

## Read a report

`examples/team/evals/results/<scenario>/<timestamp>/` (git-ignored):

- `report.md`: result, model, cost split (agent vs judge) against the cap, duration, a table of
  check scores, per-criterion judge reasons, per-task stop reasons, links to the produced files;
- `report.json`: the same, machine readable (`checks[].metrics` holds recall, precision, counts);
- `files/`: the files the agent produced.

The total is the weighted mean of all check scores; the run passes when it reaches
`passThreshold`, no required check failed and the budget held. `compare` prints the total, cost
and per-check score deltas between two runs (a folder, `<scenario>/<runId>` or
`<scenario>/latest`). Change one thing between runs (a prompt, a skill, the model), run with the
same `--repeat`, compare.

## Use your own examples

Replace the fixture with your real input and the answer key or rubric with your real expectations:
a client's good past outputs are the best rubric material. The shipped scenarios (`community-audit`,
`research-queue`, `writer-drafts`) are illustrative and generic.
