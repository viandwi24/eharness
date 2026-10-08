import { describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { DiffView, diffRows } from '../src/ui/DiffView.tsx'

// Real `git diff HEAD -M` output.
const FIXTURE = {
  'README.md': `diff --git a/README.md b/README.md
index ac9837c..813b04e 100644
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 line 1
 line 2
-line 3
+line THREE
 line 4
 line 5
 line 6
@@ -22,7 +22,7 @@ line 21
 line 22
 line 23
 line 24
-line 25
+line 25 changed
 line 26
 line 27
 line 28
`,
  'gone.txt': `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 587be6b..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
`,
  'keep.txt': `diff --git a/keep.txt b/keep.txt
index b68fde2..23fa7d3 100644
--- a/keep.txt
+++ b/keep.txt
@@ -1 +1 @@
-k
+k
\\ No newline at end of file
`,
  'logo.bin': `diff --git a/logo.bin b/logo.bin
index 388941a..d85a26a 100644
Binary files a/logo.bin and b/logo.bin differ
`,
  'ren.txt': `diff --git a/ren.txt b/moved.txt
similarity index 87%
rename from ren.txt
rename to moved.txt
index c4fa11d..1879930 100644
--- a/ren.txt
+++ b/moved.txt
@@ -1,7 +1,7 @@
 p
 q
 r
-s
+S
 t
 u
 v
`,
  'new.txt': `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..9db7df0
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
`,
}

const lines = (patch: string): string[] =>
  (render(<DiffView patch={patch} maxLines={100} />).lastFrame() ?? '')
    .split('\n')
    .map((l) => l.trimEnd())

describe('DiffView with real git patches', () => {
  test('modified file with two hunks', () => {
    const out = lines(FIXTURE['README.md'])
    console.log(out.join('\n'))
    expect(out.join('\n')).not.toContain('iff --git')
    expect(out.join('\n')).not.toContain('index ')
    expect(out[0]).toBe('README.md')
    expect(out).toContain(' 3 - line 3')
    expect(out).toContain(' 3 + line THREE')
    expect(out).toContain(' 1   line 1')
    expect(out.some((l) => l.trim() === '⋯')).toBe(true)
    expect(out).toContain('25 - line 25')
    expect(out).toContain('25 + line 25 changed')
    expect(out).toContain('22   line 22')
  })

  test('new file from /dev/null', () => {
    const out = lines(FIXTURE['new.txt'])
    expect(out[0]).toBe('new.txt · new file')
    expect(out).toContain(' 1 + hello')
    expect(out).toContain(' 2 + world')
    expect(out).toContain('     No newline at end of file')
    expect(out.join('\n')).not.toContain('/dev/null')
  })

  test('rename with changes', () => {
    const out = lines(FIXTURE['ren.txt'])
    expect(out[0]).toBe('moved.txt · renamed from ren.txt')
    expect(out).toContain(' 4 - s')
    expect(out).toContain(' 4 + S')
    expect(out.join('\n')).not.toContain('similarity')
    expect(out.join('\n')).not.toContain('rename to')
  })

  test('deletion', () => {
    const out = lines(FIXTURE['gone.txt'])
    expect(out[0]).toBe('gone.txt · deleted')
    expect(out).toContain(' 1 - x')
    expect(out).toHaveLength(2)
  })

  test('binary', () => {
    const out = lines(FIXTURE['logo.bin'])
    expect(out).toEqual(['logo.bin · binary'])
  })

  test('no newline marker is a note, not a row', () => {
    const rows = diffRows({ patch: FIXTURE['keep.txt'] })
    expect(rows.map((r) => r.kind)).toEqual(['header', 'remove', 'add', 'note'])
  })

  test('whole multi-file patch renders every file without raw headers', () => {
    const all = Object.values(FIXTURE).join('')
    const text = lines(all).join('\n')
    expect(text).not.toContain('diff --git')
    expect(text).not.toContain('+++ ')
    expect(text).not.toContain('@@')
  })

  test('removed line that looks like a header is kept', () => {
    const rows = diffRows({ patch: '@@ -1,2 +1,2 @@\n--- a\n+++ b\n ctx\n' })
    expect(rows).toEqual([
      { kind: 'remove', line: 1, text: '-- a' },
      { kind: 'add', line: 1, text: '++ b' },
      { kind: 'context', line: 2, text: 'ctx' },
    ])
  })

  test('headerless snippet patches still work', () => {
    const rows = diffRows({ patch: '@@ -5,2 +5,2 @@\n keep\n-a\n+b\n' })
    expect(rows).toEqual([
      { kind: 'context', line: 5, text: 'keep' },
      { kind: 'remove', line: 6, text: 'a' },
      { kind: 'add', line: 6, text: 'b' },
    ])
  })
})
