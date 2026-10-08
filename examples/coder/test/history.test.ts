import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { addHistory, HISTORY_MAX_LINES, readHistory } from '../src/app/history.ts'
import { makeController, tempDir } from './helpers.ts'

describe('history', () => {
  test('stores one JSON line per prompt and drops consecutive duplicates', async () => {
    const dir = await tempDir()
    await addHistory(dir, '/p', 'one')
    await addHistory(dir, '/p', 'one')
    await addHistory(dir, '/p', 'two')
    await addHistory(dir, '/p', 'one')
    await addHistory(dir, '/p', '   ')
    const lines = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).text)).toEqual(['one', 'two', 'one'])
    expect(JSON.parse(lines[0] as string)).toMatchObject({ project: '/p', text: 'one' })
    expect(typeof JSON.parse(lines[0] as string).at).toBe('number')
  })

  test('reads this project newest last, or all projects, with a limit', async () => {
    const dir = await tempDir()
    await addHistory(dir, '/a', 'a1')
    await addHistory(dir, '/b', 'b1')
    await addHistory(dir, '/a', 'a2')
    expect(await readHistory(dir, '/a')).toEqual(['a1', 'a2'])
    expect(await readHistory(dir, '/a', { allProjects: true })).toEqual(['a1', 'b1', 'a2'])
    expect(await readHistory(dir, '/a', { allProjects: true, limit: 2 })).toEqual(['b1', 'a2'])
    expect(await readHistory(dir, '/missing')).toEqual([])
  })

  test('concurrent writes all land and the file is trimmed to the cap', async () => {
    const dir = await tempDir()
    await Promise.all(
      Array.from({ length: HISTORY_MAX_LINES + 20 }, (_, i) => addHistory(dir, '/p', `p${i}`)),
    )
    const lines = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.length).toBe(HISTORY_MAX_LINES)
    expect(JSON.parse(lines.at(-1) as string).text).toBe(`p${HISTORY_MAX_LINES + 19}`)
    expect(JSON.parse(lines[0] as string).text).toBe('p20')
  })

  test('skips corrupt lines', async () => {
    const dir = await tempDir()
    await Bun.write(join(dir, 'history.jsonl'), 'not json\n{"at":1,"project":"/p","text":"ok"}\n')
    expect(await readHistory(dir, '/p')).toEqual(['ok'])
  })

  test('the controller keeps history under CODER_HOME for its project', async () => {
    const { controller, root, home } = await makeController({ model: scriptedModel([]) })
    await controller.addHistory('first prompt')
    await controller.addHistory('second prompt')
    expect(await controller.history()).toEqual(['first prompt', 'second prompt'])
    expect(await controller.history({ limit: 1 })).toEqual(['second prompt'])
    expect(await readFile(join(home, 'history.jsonl'), 'utf8')).toContain(JSON.stringify(root))
  })
})
