/**
 * Keep warnings out of the Ink UI: AI SDK warnings (`AI_SDK_LOG_WARNINGS`) and Node/Bun process
 * warnings (`process.on('warning')`) go to `<userDir>/warnings.log` instead of stderr.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Append one line to `<userDir>/warnings.log`; never throws. */
export function logWarning(userDir: string, line: string): void {
  void mkdir(userDir, { recursive: true })
    .then(() => appendFile(join(userDir, 'warnings.log'), `${new Date().toISOString()} ${line}\n`))
    .catch(() => {})
}

/** Text of an AI SDK warning (a `{ type, ... }` object, or a plain string). */
export function describeSdkWarning(warning: unknown): string {
  if (typeof warning === 'string') return warning
  try {
    return `ai-sdk: ${JSON.stringify(warning)}`
  } catch {
    return `ai-sdk: ${String(warning)}`
  }
}

/**
 * Route AI SDK and process warnings to the log. Returns a function that restores the previous
 * handlers. Interactive mode only: print mode keeps the stderr behaviour.
 */
export function installWarningSinks(userDir: string): () => void {
  const g = globalThis as { AI_SDK_LOG_WARNINGS?: unknown }
  const previous = g.AI_SDK_LOG_WARNINGS
  g.AI_SDK_LOG_WARNINGS = (options: { warnings?: unknown[] } | unknown): void => {
    const list = (options as { warnings?: unknown[] }).warnings
    for (const w of Array.isArray(list) ? list : [options])
      logWarning(userDir, describeSdkWarning(w))
  }
  const previousListeners = process.listeners('warning')
  process.removeAllListeners('warning')
  const onProcessWarning = (warning: Error): void =>
    logWarning(userDir, `process ${warning.name}: ${warning.message}`)
  process.on('warning', onProcessWarning)
  return () => {
    g.AI_SDK_LOG_WARNINGS = previous
    process.off('warning', onProcessWarning)
    for (const l of previousListeners) process.on('warning', l)
  }
}
