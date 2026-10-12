/**
 * One command for the team e2e environment (see SCENARIOS.md):
 *
 *   bun examples/team/e2e/start.ts [--reset] [--build] [--tracker-only | --team-only]
 *
 * (`--tracker-only` / `--team-only` start one half, so a scenario can stop and restart it alone.)
 * Starts the Tracker (demo) on 4991 and a dedicated team server on 4990 that also serves the built
 * web, with a throwaway data dir under the OS temp folder. Ctrl+C stops both.
 *
 *   E2E_MODEL (default deepseek/deepseek-v4.1-flash)   E2E_BUDGET (default 20, USD)
 *   E2E_DIR (default <tmp>/eharness-team-e2e)          --reset wipes the data dir   --build rebuilds the web
 *
 * The model key is read from examples/team/.env (OPENROUTER_API_KEY); the token is generated and
 * written to <dir>/token (only the path is printed).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const teamDir = resolve(here, '..')
const TEAM_PORT = 4990
const TRACKER_PORT = 4991
const dir = process.env.E2E_DIR ?? join(tmpdir(), 'eharness-team-e2e')
const args = new Set(process.argv.slice(2))
const withTracker = !args.has('--team-only')
const withTeam = !args.has('--tracker-only')

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

if (withTeam && args.has('--reset') && existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true })
  console.log(`Wiped ${dir}`)
}
mkdirSync(join(dir, 'data'), { recursive: true })

const tokenFile = join(dir, 'token')
if (!existsSync(tokenFile)) {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  writeFileSync(tokenFile, `e2e-${Buffer.from(bytes).toString('base64url')}`, { mode: 0o600 })
}
const token = readFileSync(tokenFile, 'utf8').trim()

const dotenv = withTeam ? readEnvFile(join(teamDir, '.env')) : {}
const key = dotenv.OPENROUTER_API_KEY
if (withTeam && (key === undefined || key === '')) {
  console.error('OPENROUTER_API_KEY missing in examples/team/.env')
  process.exit(1)
}

const webDir = join(teamDir, 'web')
const buildDir = join(webDir, 'build')
if (withTeam && (args.has('--build') || !existsSync(join(buildDir, 'index.html')))) {
  console.log('Building the web (bun run build in examples/team/web)...')
  const b = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: webDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (b.exitCode !== 0) process.exit(b.exitCode ?? 1)
}

const children: Array<ReturnType<typeof Bun.spawn>> = []
if (withTracker) {
  const tracker = Bun.spawn(['bun', join(here, 'tracker/server.ts')], {
    env: { ...process.env, PORT: String(TRACKER_PORT), TRACKER_TZ: 'Asia/Jakarta' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  children.push(tracker)
}

const base = `http://localhost:${TEAM_PORT}`
if (withTeam) {
  const team = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: join(teamDir, 'server'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      OPENROUTER_API_KEY: key ?? '',
      ...(dotenv.OPENROUTER_BASE_URL === undefined
        ? {}
        : { OPENROUTER_BASE_URL: dotenv.OPENROUTER_BASE_URL }),
      TEAM_MODEL: process.env.E2E_MODEL ?? 'deepseek/deepseek-v4.1-flash',
      TEAM_BUDGET_USD: process.env.E2E_BUDGET ?? '20',
      TEAM_TOKEN: token,
      PORT: String(TEAM_PORT),
      TEAM_DB: join(dir, 'data', 'team.db'),
      TEAM_WEB_DIR: buildDir,
      TEAM_PUBLIC_URL: `${base}/api`,
      TEAM_WEB_URL: base,
      TEAM_ALLOW_PRIVATE_MCP: '1',
      TEAM_ROUTINE_TICK_MS: '2000',
      TEAM_INSTANCE_ID: 'e2e',
      TZ: 'Asia/Jakarta',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  children.push(team)
}

let stopping = false
function stop(code = 0): void {
  if (stopping) return
  stopping = true
  for (const c of children) c.kill()
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
for (const c of children) {
  void c.exited.then((code) => {
    if (stopping) return
    console.error(`a child exited (${code}); stopping`)
    stop(1)
  })
}

if (!withTracker) console.log(`Team server only. Tracker must run on ${TRACKER_PORT}.`)
console.log(`
Team e2e environment
  Web + API   ${base}            (API ${base}/api, docs ${base}/api/docs)
  Tracker     http://localhost:${TRACKER_PORT}   MCP ${'http://localhost:' + TRACKER_PORT}/mcp   state /state   POST /reset
  Token file  ${tokenFile}       (paste its content on the Settings page)
  Data dir    ${dir}             (bun examples/team/e2e/start.ts --reset wipes it)
  Model       ${process.env.E2E_MODEL ?? 'deepseek/deepseek-v4.1-flash'}, budget $${process.env.E2E_BUDGET ?? '20'}
Stop with Ctrl+C.
`)
