/**
 * `MessageAdapter` + `StateAdapter` on JSON files (Node / Bun), passing the conformance suites.
 *
 *   bun examples/json-file-storage.ts     # conformance + a turn that survives a "restart"
 *
 * One `<session>.messages.json` (array sorted by id) and one `<session>.state.json` per session.
 * Writes are atomic (temp file + rename) and serialized per file inside the process, which is
 * enough for a single-process app or a CLI. Several processes on the same directory need real
 * locking: use a database (see `examples/postgres-storage.ts`).
 *
 * This is application code, not part of the library (eharness ships memory adapters only).
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UIMessage } from 'ai'
import {
  defineHarnessAgent,
  type MessageAdapter,
  type SessionStateSnapshot,
  type StateAdapter,
} from 'eharness'
import { messageAdapterConformance, stateAdapterConformance } from 'eharness/testing'
import { exampleModel } from './shared/model.ts'
import { keyedMutex } from './shared/mutex.ts'
import { runCases } from './shared/run-cases.ts'

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Atomic replace: readers see the old or the new file, never a partial one. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), 'utf8')
  await rename(temp, file)
}

function pathFor(dir: string, sessionId: string, kind: 'messages' | 'state'): string {
  // encodeURIComponent maps any session id to one safe file name ('/' → %2F)
  return join(dir, `${encodeURIComponent(sessionId)}.${kind}.json`)
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Messages of a session in `<dir>/<session>.messages.json`, sorted by id, upserted by id. */
export function jsonFileMessages(dir: string): MessageAdapter {
  const exclusive = keyedMutex()
  const all = async (sessionId: string) =>
    (await readJson<UIMessage[]>(pathFor(dir, sessionId, 'messages'))) ?? []

  return {
    async load({ sessionId, fromId, beforeId, limit }) {
      if (fromId !== undefined && beforeId !== undefined) {
        throw new TypeError('load: pass either fromId or beforeId, not both')
      }
      let messages = await all(sessionId) // freshly parsed: callers get copies
      if (fromId !== undefined) return messages.filter((m) => m.id >= fromId)
      if (beforeId !== undefined) messages = messages.filter((m) => m.id < beforeId)
      if (limit !== undefined) messages = limit > 0 ? messages.slice(-limit) : []
      return messages
    },
    async save(sessionId, messages) {
      const file = pathFor(dir, sessionId, 'messages')
      await exclusive(file, async () => {
        await mkdir(dir, { recursive: true })
        const stored = new Map((await all(sessionId)).map((m) => [m.id, m]))
        for (const message of messages) stored.set(message.id, message)
        await writeJson(file, [...stored.values()].sort(byId))
      })
    },
    async lastId(sessionId) {
      return (await all(sessionId)).at(-1)?.id ?? null
    },
  }
}

/** Session state in `<dir>/<session>.state.json`, with compare-and-set on `rev`. */
export function jsonFileState(dir: string): StateAdapter {
  const exclusive = keyedMutex()
  const write = async (file: string, state: SessionStateSnapshot) => {
    await mkdir(dir, { recursive: true })
    await writeJson(file, state)
  }
  return {
    get: (sessionId) => readJson<SessionStateSnapshot>(pathFor(dir, sessionId, 'state')),
    async set(sessionId, state) {
      const file = pathFor(dir, sessionId, 'state')
      await exclusive(file, () => write(file, state))
    },
    async setIf(sessionId, state, expectedRev) {
      const file = pathFor(dir, sessionId, 'state')
      return exclusive(file, async () => {
        const current = await readJson<SessionStateSnapshot>(file)
        if ((current?.rev ?? null) !== expectedRev) return false
        await write(file, state)
        return true
      })
    },
  }
}

if (import.meta.main) {
  const dir = await mkdtemp(join(tmpdir(), 'eharness-json-'))
  try {
    await runCases(
      'MessageAdapter conformance (JSON files)',
      messageAdapterConformance(() => jsonFileMessages(dir), { requireLastId: true }),
    )
    await runCases(
      'StateAdapter conformance (JSON files)',
      stateAdapterConformance(() => jsonFileState(dir)),
    )

    // A turn, then a "restart": a new agent instance on the same directory sees the history.
    const storage = () => ({ messages: jsonFileMessages(dir), state: jsonFileState(dir) })
    const first = defineHarnessAgent({
      model: exampleModel([{ text: 'Nice to meet you, Ada.' }]),
      contextWindow: 200_000,
      storage: storage(),
    })
    await first.session('s1').send('Hi, I am Ada.').result
    await first.close()

    const model = exampleModel([{ text: 'Your name is Ada.' }])
    const second = defineHarnessAgent({ model, contextWindow: 200_000, storage: storage() })
    const result = await second.session('s1').send('What is my name?').result
    const history = await second.session('s1').messages()
    console.log(`\nafter restart: ${history.length} messages, last turn ${result.stop}`)
    for (const m of history) {
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
      console.log(`  ${m.role}: ${text}`)
    }
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
