import { describe, expect, test } from 'bun:test'
import { mkdir, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { diskFs } from 'eharness/filesystem/node'
import { addDirectory, listMemoryFiles, loadUserMemory } from '../src/app/memory-files.ts'
import { createWorkspace } from '../src/workspace/index.ts'
import { setup, tempDir, writeFiles } from './helpers.ts'

describe('memory files', () => {
  test('user, project and nested files; CLAUDE.md wins over AGENTS.md per directory', async () => {
    const root = await tempDir()
    const userDir = await tempDir()
    await writeFiles(root, {
      'CLAUDE.md': 'claude',
      'AGENTS.md': 'agents',
      'pkg/AGENTS.md': 'nested',
      'node_modules/x/AGENTS.md': 'ignored',
    })
    await writeFiles(userDir, { 'AGENTS.md': 'user rules' })
    const fs = diskFs(root)
    const list = await listMemoryFiles({ fs, root, userDir })
    expect(list.map((f) => [f.path, f.scope, f.exists])).toEqual([
      ['~/.coder/AGENTS.md', 'user', true],
      ['CLAUDE.md', 'project', true],
      ['pkg/AGENTS.md', 'project', true],
    ])
    expect(list[1]?.real).toBe(join(root, 'CLAUDE.md'))
    expect(list[1]?.ignored).toEqual(['AGENTS.md'])
    expect(list[0]?.ignored).toBeUndefined()
    expect((await loadUserMemory(userDir))?.text).toBe('user rules')

    await writeFiles(userDir, { 'CLAUDE.md': 'user claude' })
    const again = await listMemoryFiles({ fs, root, userDir })
    expect(again[0]).toMatchObject({ path: '~/.coder/CLAUDE.md', ignored: ['AGENTS.md'] })
    expect(await loadUserMemory(userDir)).toMatchObject({ name: 'CLAUDE.md', text: 'user claude' })
  })

  test('only AGENTS.md is used when there is no CLAUDE.md', async () => {
    const root = await tempDir()
    const userDir = await tempDir()
    await writeFiles(root, { 'AGENTS.md': 'agents' })
    const list = await listMemoryFiles({ fs: diskFs(root), root, userDir })
    expect(list[1]).toMatchObject({ path: 'AGENTS.md', exists: true })
  })

  test('missing files are listed as not existing', async () => {
    const root = await tempDir()
    const userDir = await tempDir()
    const list = await listMemoryFiles({ fs: diskFs(root), root, userDir })
    expect(list.map((f) => [f.path, f.exists])).toEqual([
      ['~/.coder/AGENTS.md', false],
      ['AGENTS.md', false],
    ])
    expect(await loadUserMemory(userDir)).toBeUndefined()
  })
})

describe('addDirectory', () => {
  test('mounts a directory (symlinks resolved) and rejects bad paths', async () => {
    const { config } = await setup()
    const workspace = await createWorkspace(config)
    const other = await tempDir('coder-other-')
    const virtual = await addDirectory(workspace, other)
    expect(virtual.startsWith('/@dirs/')).toBe(true)
    expect(workspace.mounts().some((m) => m.real === other)).toBe(true)

    const link = join(await tempDir(), 'link')
    const target = await tempDir('coder-target-')
    await symlink(target, link)
    await addDirectory(workspace, link)
    expect(workspace.mounts().some((m) => m.real === target)).toBe(true)

    await expect(addDirectory(workspace, '')).rejects.toThrow(/Give a directory/)
    await expect(addDirectory(workspace, 'relative/dir')).rejects.toThrow(/absolute/)
    await expect(addDirectory(workspace, join(other, 'missing'))).rejects.toThrow(
      /No such directory/,
    )
    await writeFiles(other, { 'file.txt': 'x' })
    await expect(addDirectory(workspace, join(other, 'file.txt'))).rejects.toThrow(
      /Not a directory/,
    )
    await expect(addDirectory(workspace, '/')).rejects.toThrow(/too broad/)
    await expect(addDirectory(workspace, '~')).rejects.toThrow(/too broad/)
    await expect(addDirectory(workspace, join(config.root, '..'))).rejects.toThrow(/too broad/)
    await expect(addDirectory(workspace, config.root)).rejects.toThrow(/too broad/)
  })

  test('~/ is expanded', async () => {
    const { config } = await setup()
    const workspace = await createWorkspace(config)
    await expect(addDirectory(workspace, '~/definitely-missing-dir-xyz')).rejects.toThrow(
      /No such directory: ~\/definitely-missing-dir-xyz/,
    )
    await mkdir(homedir(), { recursive: true })
  })
})
