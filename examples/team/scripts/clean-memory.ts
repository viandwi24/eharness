/**
 * One-off cleanup of memory files that record system or state facts (roles, admin status,
 * permissions, what the bot can do). Older versions of the agent wrote such notes after chat
 * conversations; they go stale and can mislead the agent. NOT run automatically.
 *
 *   bun examples/team/scripts/clean-memory.ts                      # list (dry run, changes nothing)
 *   bun examples/team/scripts/clean-memory.ts --db path/to/team.db
 *   bun examples/team/scripts/clean-memory.ts --prefix /memories/agents/<agent id>
 *   bun examples/team/scripts/clean-memory.ts --remove /memories/agents/<id>/a.md [--remove ...]
 *   bun examples/team/scripts/clean-memory.ts --remove-all         # every flagged file
 *
 * Defaults: `--db` = TEAM_DB or ./data/team.db (relative to where you run it, normally
 * examples/team/server); `--prefix` = /memories. It uses the same detector as the write guard of
 * channel sessions (`systemFactIn`), so what it flags is what the guard would now refuse. A file is
 * flagged when any line states a role, admin status, permission or capability: read the listed
 * lines before you remove anything, a flagged file can hold other useful notes too. Before any
 * removal the full text of the files is saved next to the database as
 * `memory-cleanup-backup-<time>.json`. Stop the server first if you can (SQLite handles a second
 * writer, but a running agent may be editing the same file).
 */
import { Database } from 'bun:sqlite'
import { dirname, join, resolve } from 'node:path'
import { systemFactIn } from '../server/src/infra/channels/medium.ts'
import { libraryFs } from '../server/src/infra/eh/library-fs.ts'

const args = process.argv.slice(2)
const flag = (name: string): string[] => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++)
    if (args[i] === name && args[i + 1] !== undefined) out.push(args[i + 1] as string)
  return out
}
const dbFile = resolve(flag('--db')[0] ?? process.env.TEAM_DB ?? './data/team.db')
const prefix = flag('--prefix')[0] ?? '/memories'
const removeAll = args.includes('--remove-all')
const removeFiles = flag('--remove')

const sqlite = new Database(dbFile)
sqlite.exec('PRAGMA busy_timeout = 5000')
const fs = libraryFs(sqlite)

if (sqlite.query("SELECT name FROM sqlite_master WHERE name = 'library_files'").get() === null) {
  console.error(
    `${dbFile} has no library_files table: is this the team database? Pass --db <path>.`,
  )
  process.exit(1)
}

const flagged: Array<{ path: string; lines: string[]; text: string }> = []
for (const meta of await fs.list(prefix)) {
  if (meta.binary === true || !meta.path.startsWith('/memories/')) continue
  const file = await fs.read(meta.path)
  if (file === null || file === undefined || typeof file.content !== 'string') continue
  const lines = file.content.split('\n').filter((l) => systemFactIn(l) !== undefined)
  if (lines.length > 0) flagged.push({ path: meta.path, lines, text: file.content })
}

console.log(`${dbFile}: ${flagged.length} memory file(s) under ${prefix} state system facts.`)
for (const f of flagged) {
  console.log(`\n${f.path}  (${f.text.length} chars)`)
  for (const l of f.lines.slice(0, 6)) console.log(`   | ${l.trim().slice(0, 160)}`)
  if (f.lines.length > 6) console.log(`   | ... ${f.lines.length - 6} more line(s)`)
}

const toRemove = removeAll ? flagged : flagged.filter((f) => removeFiles.includes(f.path))
for (const p of removeFiles)
  if (!flagged.some((f) => f.path === p)) console.log(`\nNot flagged, not removed: ${p}`)
if (toRemove.length === 0) {
  console.log(
    flagged.length === 0
      ? '\nNothing to clean.'
      : '\nNothing removed. To remove, pass --remove <path> (repeatable) or --remove-all.',
  )
  process.exit(0)
}
const backup = join(
  dirname(dbFile),
  `memory-cleanup-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
)
await Bun.write(
  backup,
  JSON.stringify(
    toRemove.map(({ path, text }) => ({ path, text })),
    null,
    2,
  ),
)
console.log(`\nBackup written: ${backup}`)
for (const f of toRemove) {
  const r = await fs.delete(f.path)
  console.log(`${r.ok ? 'Removed' : `Could not remove (${r.reason})`}: ${f.path}`)
}
