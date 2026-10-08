/** Last chosen model and thinking level, per project: `<projectDataDir>/preferences.json`. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ModelProvider, THINKING_LEVELS, type ThinkingLevel } from '../contracts.ts'

/** What is remembered between runs. */
export interface Preferences {
  provider?: ModelProvider
  model?: string
  thinking?: ThinkingLevel
}

/** Path of the preferences file of a project. */
export const preferencesFile = (projectDataDir: string): string =>
  join(projectDataDir, 'preferences.json')

/** Read the preferences; a missing or corrupt file (or a bad field) yields no preference. */
export async function loadPreferences(projectDataDir: string): Promise<Preferences> {
  try {
    const json = JSON.parse(await readFile(preferencesFile(projectDataDir), 'utf8')) as Record<
      string,
      unknown
    >
    const out: Preferences = {}
    if (json.provider === 'openrouter' || json.provider === 'gateway') out.provider = json.provider
    if (typeof json.model === 'string' && json.model.trim() !== '') out.model = json.model
    if (THINKING_LEVELS.includes(json.thinking as ThinkingLevel)) {
      out.thinking = json.thinking as ThinkingLevel
    }
    return out
  } catch {
    return {}
  }
}

/** Merge `patch` into the saved preferences (atomic write). Failures are ignored: it is a convenience. */
export async function savePreferences(projectDataDir: string, patch: Preferences): Promise<void> {
  try {
    const file = preferencesFile(projectDataDir)
    const next = { ...(await loadPreferences(projectDataDir)), ...patch }
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`)
    await rename(temp, file)
  } catch {
    // not worth failing a command over
  }
}
