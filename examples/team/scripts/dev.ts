/**
 * `bun run dev` in examples/team: start the server and the web dev server together, with
 * prefixed output, and stop both on Ctrl+C or when either one exits (no process is left behind).
 * Both read examples/team/.env (see .env.example).
 */
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const mode = process.argv[2] === 'start' ? 'start' : 'dev'

type Child = { name: string; proc: ReturnType<typeof Bun.spawn> }

function start(name: string, cwd: string, cmd: string[]): Child {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const decoder = new TextDecoder()
      let rest = ''
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        rest += decoder.decode(chunk, { stream: true })
        const lines = rest.split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) console.log(`[${name}] ${line}`)
      }
      if (rest) console.log(`[${name}] ${rest}`)
    })()
  }
  return { name, proc }
}

const children: Child[] = [
  start('server', join(root, 'server'), ['bun', 'run', mode]),
  start('web', join(root, 'web'), ['bun', 'run', mode === 'start' ? 'preview' : 'dev']),
]

let stopping = false
async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true
    for (const c of children) c.proc.kill('SIGTERM')
    // give them a moment, then force
    const timer = setTimeout(() => {
      for (const c of children) c.proc.kill('SIGKILL')
    }, 3000)
    await Promise.all(children.map((c) => c.proc.exited))
    clearTimeout(timer)
  }
  process.exit(code)
}

process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))
for (const c of children) {
  void c.proc.exited.then((code) => {
    if (stopping) return
    console.log(`[${c.name}] exited with code ${code}; stopping the others`)
    void stop(code ?? 1)
  })
}
