/**
 * Production entry of the container: runs `src/main.ts` and starts it again when it exits with
 * code 75 (a whole-database restore staged a copy and asked for a restart, P58). Any other exit
 * code ends the container as before, so the orchestrator's own restart policy still applies.
 * SIGTERM and SIGINT are passed on to the server, which shuts down gracefully.
 */
import { join } from 'node:path'

const RESTART_CODE = 75
const main = join(import.meta.dir, '..', 'src', 'main.ts')

let child: ReturnType<typeof Bun.spawn> | undefined
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true
    child?.kill(signal)
  })
}

for (;;) {
  child = Bun.spawn(['bun', main], { stdio: ['inherit', 'inherit', 'inherit'], env: process.env })
  const code = await child.exited
  if (stopping || code !== RESTART_CODE) process.exit(code)
  console.log('team: restarting after a database restore')
}
