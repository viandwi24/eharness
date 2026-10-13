/** An in-memory `Sandbox` for the code plugin's tests: a Map of files and a scripted `run`/`spawn`. */
import { createHash } from 'node:crypto'
import type { CodeSandbox } from './sync.ts'

export interface ScriptCall {
  python: string
  script: string
  args: string[]
  env: Record<string, string>
  command: string
}

export interface FakeSandbox extends CodeSandbox {
  files: Map<string, Uint8Array>
  /** Paths written by `writeTextFile` / `writeBinaryFile` (without `.eh-code/`). */
  uploads: string[]
  /** Every command seen by `run` or `spawn`. */
  commands: string[]
  /** Called for a script run; mutate `files` to simulate Python. */
  onScript: (
    call: ScriptCall,
    files: Map<string, Uint8Array>,
  ) => { exitCode: number; output: string } | Promise<{ exitCode: number; output: string }>
  /** Called for `run` commands the fake does not know (installer commands). */
  onCommand?: (command: string) => { exitCode: number; stdout: string; stderr: string } | undefined
  /** The next spawn fails with this error. */
  failSpawn?: Error
  wipe(): void
  disposed: boolean
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function split(command: string): string[] {
  const out: string[] = []
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    out.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : (m[2] as string))
  }
  return out
}

const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex')

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text !== '') controller.enqueue(enc.encode(text))
      controller.close()
    },
  })
}

export function fakeSandbox(init: Partial<FakeSandbox> = {}): FakeSandbox {
  const sb: FakeSandbox = {
    description: 'fake',
    files: new Map(),
    uploads: [],
    commands: [],
    disposed: false,
    onScript: () => ({ exitCode: 0, output: '' }),
    wipe() {
      sb.files.clear()
    },
    async dispose() {
      sb.disposed = true
    },
    readFile: async ({ path }) =>
      sb.files.has(path) ? stream(dec.decode(sb.files.get(path))) : null,
    readBinaryFile: async ({ path }) => sb.files.get(path) ?? null,
    readTextFile: async ({ path }) => {
      const b = sb.files.get(path)
      return b === undefined ? null : dec.decode(b)
    },
    writeFile: async () => {},
    writeBinaryFile: async ({ path, content }) => {
      sb.files.set(path, content)
      if (!path.startsWith('.eh-code/')) sb.uploads.push(path)
    },
    writeTextFile: async ({ path, content }) => {
      sb.files.set(path, enc.encode(content))
      if (!path.startsWith('.eh-code/')) sb.uploads.push(path)
    },
    run: async (call) => {
      // installer commands start with `mkdir -p -- <envRoot> && cd <envRoot> && `
      const command = call.command.replace(/^mkdir -p -- '[^']*' && cd '[^']*' && /, '')
      sb.commands.push(command)
      const tokens = split(command)
      if (command.includes('.eh-code/list.py')) {
        const cfg = JSON.parse(dec.decode(sb.files.get('.eh-code/list-args.json'))) as {
          dirs: string[]
          ignore: string[]
          only?: string[]
        }
        const ignore = cfg.ignore.map((s) => new RegExp(s))
        const rows = [...sb.files]
          .filter(([p]) => !p.startsWith('.eh-code/'))
          .filter(([p]) =>
            cfg.only !== undefined
              ? cfg.only.includes(p)
              : cfg.dirs.some((d) => d === '.' || p.startsWith(`${d}/`)),
          )
          .filter(([p]) => !ignore.some((r) => r.test(p)))
          .map(([path, b]) => ({ path, size: b.length, sha1: sha1(b) }))
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' }
      }
      if (tokens[0] === 'find') return { exitCode: 0, stdout: '', stderr: '' }
      if (tokens[0] === 'rm' && tokens[1] === '-f') {
        for (const p of tokens.slice(3)) sb.files.delete(p)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (tokens[0] === 'rm' && tokens[1] === '-rf' && tokens[2] === '--') {
        for (const d of tokens.slice(3)) {
          for (const p of [...sb.files.keys()]) if (p.startsWith(`${d}/`)) sb.files.delete(p)
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      const custom = sb.onCommand?.(command)
      if (custom !== undefined) return custom
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    spawn: async ({ command, env }) => {
      sb.commands.push(command)
      if (sb.failSpawn !== undefined) {
        const error = sb.failSpawn
        delete sb.failSpawn
        throw error
      }
      const t = split(command.replace(/^mkdir -p -- \S+; HOME="[^"]*" /, ''))
      const flagsEnd = t.findIndex((x, i) => i > 0 && !x.startsWith('-'))
      const call: ScriptCall = {
        python: t[0] as string,
        script: (t[flagsEnd] as string).replace(/^\.\//, ''),
        args: t.slice(flagsEnd + 1),
        env: env ?? {},
        command,
      }
      let killed = false
      let killNow: () => void = () => {}
      const killedP = new Promise<{ exitCode: number; output: string }>((resolve) => {
        killNow = () => resolve({ exitCode: 137, output: '' })
      })
      const done = Promise.race([Promise.resolve(sb.onScript(call, sb.files)), killedP])
      return {
        stdout: new ReadableStream({
          async start(controller) {
            const r = await done.catch(() => ({ output: '' }))
            if (r.output !== '') controller.enqueue(enc.encode(r.output))
            controller.close()
          },
        }),
        stderr: stream(''),
        wait: async () => {
          const r = await done
          return { exitCode: killed ? 137 : r.exitCode }
        },
        kill: async () => {
          killed = true
          killNow()
        },
      }
    },
    ...init,
  } as FakeSandbox
  return sb
}

export const text = (sb: FakeSandbox, path: string): string | undefined => {
  const b = sb.files.get(path)
  return b === undefined ? undefined : dec.decode(b)
}

/** Wrap `run` of a fake: `fn` gets the options and the original `run`. */
export function wrapRun(
  sb: FakeSandbox,
  fn: (
    options: { command: string },
    original: FakeSandbox['run'],
  ) => ReturnType<FakeSandbox['run']>,
): void {
  const original = sb.run.bind(sb)
  Object.assign(sb, { run: (options: { command: string }) => fn(options, original) })
}
