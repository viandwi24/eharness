/** Status of the code sandbox (`TEAM_CODE_*`), as the Settings page shows it. Pure. */
export type CodeDriver = 'off' | 'local'
export type CodeInstall = 'off' | 'allowlist' | 'any'

export interface CodeSandboxInfo {
  driver: CodeDriver
  /** Python version; null when off, unknown or inside docker. */
  python: string | null
  /** An OS sandbox or a container, and no network. */
  isolated: boolean
  install: CodeInstall
  /** One line for people. */
  label: string
}
