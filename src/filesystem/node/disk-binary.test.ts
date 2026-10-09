/** `diskFs` binary files (spec 08 §12): bytes, versions, limits, listing and search. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesVersion, contentVersion } from '../version.ts'
import { diskFs } from './disk-fs.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eh-diskbin-')))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff, 0xfe, 7])

describe('diskFs binary files', () => {
  test('readBytes returns bytes, binary meta, media type and a bytes version', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.png'), PNG)
    const fs = diskFs(root)
    const file = await fs.readBytes?.('/a.png')
    expect(Array.from(file?.bytes ?? [])).toEqual(Array.from(PNG))
    expect(file?.mediaType).toBe('image/png')
    expect(file?.meta).toMatchObject({
      path: '/a.png',
      size: PNG.length,
      binary: true,
      version: await bytesVersion(PNG),
    })
    expect((await fs.stat?.('/a.png'))?.version).toBe(file?.meta.version)
    expect(await fs.readBytes?.('/missing.png')).toBeNull()
  })

  test('writeBytes writes binary files atomically with compare-and-set; text bytes get the text version', async () => {
    const root = await temp()
    const fs = diskFs(root)
    const created = await fs.writeBytes?.('/x/a.bin', PNG, { ifVersion: null })
    expect(created).toEqual({ ok: true, version: await bytesVersion(PNG) })
    expect(new Uint8Array(await readFile(join(root, 'x/a.bin')))).toEqual(PNG)
    expect(await fs.writeBytes?.('/x/a.bin', PNG, { ifVersion: null })).toMatchObject({
      ok: false,
      reason: 'exists',
    })
    const text = await fs.writeBytes?.('/t.txt', new TextEncoder().encode('héllo'))
    expect(text).toEqual({ ok: true, version: await contentVersion('héllo') })
    expect((await fs.read('/t.txt'))?.content).toBe('héllo')
  })

  test('maxBinaryBytes: larger files are not listed and readBytes says so; text over maxFileBytes stays unreadable', async () => {
    const root = await temp()
    await writeFile(join(root, 'big.bin'), new Uint8Array(2000).fill(0))
    await writeFile(join(root, 'ok.bin'), new Uint8Array(100).fill(0))
    await writeFile(join(root, 'long.txt'), 'a'.repeat(1500))
    const fs = diskFs(root, { maxBinaryBytes: 1000, maxFileBytes: 1000 })
    expect((await fs.list()).map((m) => m.path)).toEqual(['/ok.bin'])
    await expect(fs.readBytes?.('/big.bin')).rejects.toThrow('too large file: /big.bin')
    await expect(fs.read('/long.txt')).rejects.toThrow('too large file: /long.txt')
  })

  for (const grep of ['auto', 'js'] as const) {
    test(`grep skips binary files (grep: ${grep})`, async () => {
      const root = await temp()
      await writeFile(
        join(root, 'a.bin'),
        new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1]),
      )
      await writeFile(join(root, 'a.txt'), 'needle\n')
      const fs = diskFs(root, { grep })
      expect(await fs.grep?.(/needle/)).toEqual([{ path: '/a.txt', line: 1, text: 'needle' }])
    })
  }
})
