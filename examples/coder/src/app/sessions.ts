/** Session storage on JSON files under the project data directory. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { UIMessage } from 'ai'
import { type MessageAdapter, type StateAdapter, uuidv7 } from 'eharness'
import { jsonFileMessages, jsonFileState } from '../../../json-file-storage.ts'
import type { CoderConfig, SessionSummary } from '../contracts.ts'

const SUFFIX = '.messages.json'

function sessionsDir(config: CoderConfig): string {
  return join(config.projectDataDir, 'sessions')
}

/** Message and state adapters (JSON files) for this project. */
export function createStorage(config: CoderConfig): {
  messages: MessageAdapter
  state: StateAdapter
} {
  const dir = sessionsDir(config)
  return { messages: jsonFileMessages(dir), state: jsonFileState(dir) }
}

/** A new session id (UUIDv7: sorts by creation time). */
export function newSessionId(): string {
  return uuidv7()
}

function firstUserText(messages: UIMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text
  }
  return ''
}

/** Stored sessions of this project, newest first (subagent child sessions are skipped). */
export async function listSessions(config: CoderConfig): Promise<SessionSummary[]> {
  const dir = sessionsDir(config)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: SessionSummary[] = []
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue
    let id: string
    try {
      id = decodeURIComponent(name.slice(0, -SUFFIX.length))
    } catch {
      continue
    }
    if (id.includes(':agent:')) continue
    const file = join(dir, name)
    try {
      const messages = JSON.parse(await readFile(file, 'utf8')) as UIMessage[]
      out.push({ id, updatedAt: (await stat(file)).mtimeMs, firstPrompt: firstUserText(messages) })
    } catch {
      // unreadable or half-written file: not listed
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The most recently updated session of this project. */
export async function latestSessionId(config: CoderConfig): Promise<string | undefined> {
  return (await listSessions(config))[0]?.id
}
