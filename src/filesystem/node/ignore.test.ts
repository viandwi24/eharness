/** The gitignore subset (spec 08 §8). */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileIgnore, loadIgnoreRules } from './ignore.ts'

type Row = [lines: string[], path: string, isDir: boolean, hidden: boolean]

const table: Row[] = [
  [['*.log'], 'a.log', false, true],
  [['*.log'], 'deep/dir/a.log', false, true],
  [['*.log'], 'a.logx', false, false],
  [['dist/'], 'dist', true, true],
  [['dist/'], 'dist/a.js', false, true],
  [['dist/'], 'dist', false, false], // a file named dist is not a directory
  [['dist/'], 'src/dist/a.js', false, true],
  [['/dist'], 'dist/a.js', false, true],
  [['/dist'], 'src/dist/a.js', false, false],
  [['src/gen'], 'src/gen/a.ts', false, true],
  [['src/gen'], 'other/src/gen/a.ts', false, false],
  [['docs/**/*.tmp'], 'docs/a.tmp', false, true],
  [['docs/**/*.tmp'], 'docs/x/y/a.tmp', false, true],
  [['docs/**/*.tmp'], 'other/a.tmp', false, false],
  [['**/cache'], 'a/b/cache/x', false, true],
  [['out/**'], 'out/a/b.txt', false, true],
  [['out/**'], 'out', true, false],
  [['f?.txt'], 'f1.txt', false, true],
  [['f?.txt'], 'f12.txt', false, false],
  [['[ab].txt'], 'a.txt', false, true],
  [['[ab].txt'], 'c.txt', false, false],
  [['[!ab].txt'], 'c.txt', false, true],
  [['*.log', '!keep.log'], 'keep.log', false, false],
  [['*.log', '!keep.log'], 'x.log', false, true],
  [['*.log', '!keep.log', 'keep.log'], 'keep.log', false, true], // last match wins
  [['build/', '!build/keep.txt'], 'build/keep.txt', false, true], // cannot re-include below an ignored dir
  [['# comment', '', '   ', '*.tmp'], 'a.tmp', false, true],
  [['# comment'], '# comment', false, false],
  [['\\#file'], '#file', false, true],
  [['\\!bang'], '!bang', false, true],
  [['trail   '], 'trail', false, true],
  [['*.log\r'], 'a.log', false, true],
  [[], 'node_modules/x.js', false, true], // always
  [[], 'a/node_modules', true, true],
  [[], '.git/config', false, true],
  [[], 'src/a.ts', false, false],
  [[], '', true, false],
  [[], '../x', false, false],
]

describe('ignore subset', () => {
  for (const [lines, path, isDir, hidden] of table) {
    test(`${JSON.stringify(lines)} ${path}${isDir ? '/' : ''} -> ${hidden ? 'hidden' : 'visible'}`, () => {
      expect(compileIgnore(lines).isHidden(path, isDir)).toBe(hidden)
    })
  }
})

describe('loadIgnoreRules', () => {
  test('root .gitignore applied, nested ones are not; extra patterns and gitignore: false', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'eh-ignore-')))
    try {
      await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n!keep.log\n')
      await mkdir(join(root, 'sub'))
      await writeFile(join(root, 'sub/.gitignore'), 'nested.txt\n')
      const rules = await loadIgnoreRules(root)
      expect(rules.isHidden('dist/a.js', false)).toBe(true)
      expect(rules.isHidden('keep.log', false)).toBe(false)
      expect(rules.isHidden('sub/nested.txt', false)).toBe(false)
      const off = await loadIgnoreRules(root, { gitignore: false, hidden: ['*.md'] })
      expect(off.isHidden('dist/a.js', false)).toBe(false)
      expect(off.isHidden('README.md', false)).toBe(true)
      expect(off.isHidden('node_modules/x', false)).toBe(true)
      expect((await loadIgnoreRules(join(root, 'none'))).isHidden('a.ts', false)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
