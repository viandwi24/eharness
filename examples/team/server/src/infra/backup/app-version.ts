import { readFileSync } from 'node:fs'

/**
 * The version the manifest of an export names: the repository's `package.json` when it is next to
 * the source (development, the Docker image), else `unknown`. Never throws.
 */
export function appVersion(): string {
  try {
    const file = new URL('../../../../../../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
