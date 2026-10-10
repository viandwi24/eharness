/**
 * Bearer token check. `TEAM_TOKEN` unset means open access: fine on localhost, never expose
 * such a server (documented in README).
 */
export function checkBearer(expected: string | undefined, header: string | undefined): boolean {
  if (expected === undefined || expected === '') return true
  if (header === undefined) return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const given = match?.[1] ?? ''
  if (given.length !== expected.length) return false
  // constant-time compare
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
