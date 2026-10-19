/**
 * `bun run eval`: run the eval suite.
 *
 *   bun run eval -- --scripted                 offline: replay each task's recorded transcript
 *   bun run eval -- --model <id>               real model (needs the provider key in the environment)
 *   bun run eval -- --scripted --task fix-failing-test,cli-flag
 *   bun run eval -- --validate                 check that every task's check fails on its fixture
 *
 * Other flags: --provider <name>, --concurrency <n>, --sandbox, --out <dir> (default evals/results).
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { EVALS_DIR, renderMarkdown, runSuite, validateSuite } from './runner.ts'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    model: { type: 'string' },
    provider: { type: 'string' },
    scripted: { type: 'boolean', default: false },
    task: { type: 'string' },
    concurrency: { type: 'string' },
    sandbox: { type: 'boolean', default: false },
    validate: { type: 'boolean', default: false },
    out: { type: 'string', default: join(EVALS_DIR, 'results') },
  },
})

if (values.validate) {
  const bad = await validateSuite()
  if (bad.length > 0) {
    process.stderr.write(`tasks whose check already passes on the fixture: ${bad.join(', ')}\n`)
    process.exit(1)
  }
  process.stdout.write('every task check fails on its pristine fixture\n')
  process.exit(0)
}

if (!values.scripted && values.model === undefined) {
  process.stderr.write('pass --scripted (offline replay) or --model <id> (real model)\n')
  process.exit(2)
}

const report = await runSuite({
  ...(values.model !== undefined ? { model: values.model } : {}),
  ...(values.provider !== undefined ? { provider: values.provider } : {}),
  scripted: values.scripted,
  sandbox: values.sandbox,
  ...(values.task !== undefined ? { only: values.task.split(',') } : {}),
  ...(values.concurrency !== undefined ? { concurrency: Number(values.concurrency) } : {}),
  out: values.out,
  onResult: (r) =>
    process.stderr.write(
      `${r.passed ? 'pass' : 'FAIL'} ${r.id} (${(r.wallMs / 1000).toFixed(1)} s${r.reason ? `, ${r.reason}` : ''})\n`,
    ),
})
process.stdout.write(renderMarkdown(report))
process.exit(report.passed === report.tasks ? 0 : 1)
