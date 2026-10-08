import { describe, expect, test } from 'bun:test'
import { compileGlob } from './glob.ts'

function matches(pattern: string, path: string): boolean {
  const compiled = compileGlob(pattern)
  if (!compiled.ok) throw new Error(compiled.error)
  return compiled.test(path)
}

describe('compileGlob (spec 08 §3)', () => {
  const table: Array<[string, string, boolean]> = [
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/a/b.ts', true],
    ['**/*.ts', 'src/a/b.tsx', false],
    ['src/**', 'src/a.ts', true],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**', 'src', false],
    ['src/**', 'lib/a.ts', false],
    ['*.{ts,tsx}', 'a.ts', true],
    ['*.{ts,tsx}', 'a.tsx', true],
    ['*.{ts,tsx}', 'a.js', false],
    ['*.{ts,tsx}', 'src/a.ts', false],
    ['[ab]*', 'apple', true],
    ['[ab]*', 'banana', true],
    ['[ab]*', 'cherry', false],
    ['[!ab]*', 'cherry', true],
    ['[!ab]*', 'apple', false],
    ['[a-c].md', 'b.md', true],
    ['?.md', 'a.md', true],
    ['?.md', 'ab.md', false],
    ['src/**/test/*.ts', 'src/test/a.ts', true],
    ['src/**/test/*.ts', 'src/x/y/test/a.ts', true],
    ['src/**/test/*.ts', 'src/x/a.ts', false],
    ['{src,lib}/**/*.{ts,js}', 'lib/a/b.js', true],
    ['{a,b{1,2}}.md', 'b2.md', true],
    ['{a,b{1,2}}.md', 'b3.md', false],
    ['a.b', 'axb', false],
    // dotfiles only match patterns that name them
    ['*', '.env', false],
    ['.*', '.env', true],
    ['**/*.yml', '.github/ci.yml', false],
    ['.github/**', '.github/ci.yml', true],
    ['**', 'a/.hidden/b', false],
    ['**/.gitignore', 'a/b/.gitignore', true],
    ['*.ts', 'src/a.ts', false],
  ]
  for (const [pattern, path, expected] of table) {
    test(`${pattern} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
      expect(matches(pattern, path)).toBe(expected)
    })
  }

  test('invalid patterns', () => {
    for (const bad of ['', 'a\\b', '../a', 'a/../b', '/abs', '~/x']) {
      expect(compileGlob(bad).ok).toBe(false)
    }
    expect(compileGlob(`${'{a,b}'.repeat(8)}`).ok).toBe(false)
  })
})
