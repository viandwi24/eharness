/**
 * Error rule for `src/` (K-10): public paths throw `HarnessError`, never a plain
 * `Error` / `TypeError` / `RangeError`, so `isHarnessError` and `error.code` work for callers.
 *
 * A plain throw is allowed only when it is marked, on the same line or the line above:
 *
 *   // plain-error: <why this is not a public error>
 *
 * or when the file carries `// plain-error-file: <why>` (e.g. filesystem adapters, whose
 * exceptions are an adapter contract mapped to `ERROR: …` by `onAdapterError`, spec 08).
 * Tests, test kits and `src/testing/**` are skipped.
 *
 * Exits with code 1 and lists every unmarked throw.
 */
import { resolve } from 'node:path'
import { Glob } from 'bun'

const root = resolve(import.meta.dir, '..')
const THROW = /throw new (?:Type|Range)?Error\(/
/** Files another change owns right now; convert them, then remove the entry. */
const PENDING = new Set<string>([])

const violations: string[] = []
for await (const file of new Glob('src/**/*.ts').scan({ cwd: root })) {
  if (
    /\.(test|test-d|conformance)\.ts$/.test(file) ||
    file.startsWith('src/testing/') ||
    /(^|\/)test-kit\.ts$/.test(file) ||
    PENDING.has(file)
  ) {
    continue
  }
  const text = await Bun.file(resolve(root, file)).text()
  if (text.includes('// plain-error-file:')) continue
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (!THROW.test(line)) continue
    const marked =
      line.includes('// plain-error:') || (lines[i - 1] ?? '').includes('// plain-error:')
    if (!marked) violations.push(`${file}:${i + 1}: ${line.trim()}`)
  }
}

if (violations.length > 0) {
  console.error('Plain Error throws on public paths (use HarnessError with a code, spec 10):')
  for (const v of violations) console.error(`  ${v}`)
  console.error('Internal assertions: add `// plain-error: <reason>` on or above the throw.')
  process.exit(1)
}
console.log('check-throws: ok')
