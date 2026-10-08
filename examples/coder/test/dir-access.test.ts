/** The `request_directory_access` tool. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoderConfig, Workspace } from '../src/contracts.ts'
import { createDirAccessTool, createWorkspace } from '../src/workspace/index.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function setup(): Promise<{ ws: Workspace; base: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'coder-dirs-')))
  dirs.push(base)
  await mkdir(join(base, 'project'))
  const ws = await createWorkspace({
    root: join(base, 'project'),
    projectDataDir: join(base, 'data'),
    additionalDirectories: [],
  } as unknown as CoderConfig)
  return { ws, base }
}

const call = async (ws: Workspace, path: string): Promise<string> =>
  (await createDirAccessTool(ws).execute?.(
    { path, reason: 'test' },
    { toolCallId: 't', messages: [], context: {} },
  )) as string

describe('request_directory_access', () => {
  test('mounts a directory and returns its prefix', async () => {
    const { ws, base } = await setup()
    await mkdir(join(base, 'other'))
    await writeFile(join(base, 'other/f.txt'), 'hi')
    const out = await call(ws, join(base, 'other'))
    expect(out).toContain('Mounted')
    expect(out).toContain('/@dirs/other/')
    expect((await ws.fs.read('/@dirs/other/f.txt'))?.content).toBe('hi')
    expect(await call(ws, join(base, 'other'))).toContain('/@dirs/other/') // idempotent
    expect(ws.mounts().filter((m) => m.virtual === '/@dirs/other/')).toHaveLength(1)
  })

  test('errors for missing, non-directory and relative paths', async () => {
    const { ws, base } = await setup()
    await writeFile(join(base, 'file.txt'), 'x')
    expect(await call(ws, join(base, 'nope'))).toStartWith('ERROR: no such directory')
    expect(await call(ws, join(base, 'file.txt'))).toStartWith('ERROR: not a directory')
    expect(await call(ws, 'relative/dir')).toStartWith('ERROR: the path must be absolute')
    expect(ws.mounts().some((m) => m.virtual.startsWith('/@dirs/'))).toBe(false)
  })
})

describe('request_directory_access safety', () => {
  test('rejects the root, home and a parent of the project', async () => {
    const { ws, base } = await setup()
    expect(await call(ws, '/')).toStartWith('ERROR:')
    expect(await call(ws, '~')).toStartWith('ERROR:')
    expect(await call(ws, base)).toStartWith('ERROR:') // contains the project root
    expect(ws.mounts().some((m) => m.real === base)).toBe(false)
  })

  test('reports the real path when a symlink was followed', async () => {
    const { ws, base } = await setup()
    await mkdir(join(base, 'real'))
    await symlink(join(base, 'real'), join(base, 'alias'))
    const out = await call(ws, join(base, 'alias'))
    expect(out).toContain(`Mounted ${join(base, 'real')}`)
    expect(out).toContain('symlink')
  })
})
