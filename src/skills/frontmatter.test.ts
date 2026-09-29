import { describe, expect, test } from 'bun:test'
import { parseFrontmatter, parseSkillMarkdown, serializeFrontmatter } from './frontmatter.ts'

const parse = (yaml: string) => {
  const result = parseFrontmatter(yaml)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const rejects = (yaml: string) => {
  const result = parseFrontmatter(yaml)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.error
}

describe('parseFrontmatter (YAML subset)', () => {
  test('plain scalars', () => {
    expect(
      parse(
        [
          'name: pine-v6',
          'description: Pine Script v6. Use when writing Pine, indicators, strategies.',
          'version: 3',
          'ratio: 1.5',
          'neg: -2',
          'on: true',
          'off: False',
          'nothing: null',
          'tilde: ~',
          'empty:',
          'url: https://example.com/a:b',
          'quote: say "hi" now',
        ].join('\n'),
      ),
    ).toEqual({
      name: 'pine-v6',
      description: 'Pine Script v6. Use when writing Pine, indicators, strategies.',
      version: 3,
      ratio: 1.5,
      neg: -2,
      on: true,
      off: false,
      nothing: null,
      tilde: null,
      empty: null,
      url: 'https://example.com/a:b',
      quote: 'say "hi" now',
    })
  })

  test('quoted strings', () => {
    expect(
      parse(
        [
          `single: 'it''s: fine # not a comment'`,
          'double: "line\\nnext \\"q\\" \\u00e9"',
          `num: "42"`,
          `bool: 'true'`,
          `blank: ""`,
          `after: "x" # comment`,
        ].join('\n'),
      ),
    ).toEqual({
      single: "it's: fine # not a comment",
      double: 'line\nnext "q" é',
      num: '42',
      bool: 'true',
      blank: '',
      after: 'x',
    })
  })

  test('comments, blank lines and CRLF', () => {
    expect(
      parse('# header\r\n\r\nname: x # trailing\r\nother: a#b\r\n  # indented comment\r\n'),
    ).toEqual({ name: 'x', other: 'a#b' })
    expect(parse('key: # only a comment')).toEqual({ key: null })
  })

  test('flow lists', () => {
    expect(parse(`tags: [a, "b, c", 'd', 3, true, null]\nnone: []\ntrail: [x, y,]`)).toEqual({
      tags: ['a', 'b, c', 'd', 3, true, null],
      none: [],
      trail: ['x', 'y'],
    })
  })

  test('block lists (indented or not)', () => {
    expect(parse('tools:\n  - read\n  - "write file"\n  - 2\nzero:\n- a\n- b\nnext: 1')).toEqual({
      tools: ['read', 'write file', 2],
      zero: ['a', 'b'],
      next: 1,
    })
  })

  test('one level of nesting', () => {
    expect(parse('metadata:\n  author: Jane\n  tags: [x, y]\nafter: 1')).toEqual({
      metadata: { author: 'Jane', tags: ['x', 'y'] },
      after: 1,
    })
  })

  test('rejects unsupported syntax', () => {
    rejects('description: |\n  multi\n  line')
    rejects('description: >\n  folded')
    rejects('description: first\n  continued')
    rejects('a: &anchor x')
    rejects('a: *alias')
    rejects('a: !tag x')
    rejects('a: {b: c}')
    rejects('a: [[1]]')
    rejects('a: [{b: 1}]')
    rejects('a: [1, 2')
    rejects('a: "unterminated')
    rejects("a: 'unterminated")
    rejects('a: "bad \\x escape"')
    rejects('a: "x" trailing')
    rejects('a: b: c')
    rejects('a: ends with:')
    rejects('m:\n  n:\n    deep: 1')
    rejects('m:\n  n: 1\n    deep: 2')
    rejects('l:\n  - a\n    - b')
    rejects('l:\n  - k: v')
    rejects('l:\n  - [1]')
    rejects('dup: 1\ndup: 2')
    rejects('m:\n  d: 1\n  d: 2')
    rejects('\tname: x')
    rejects('  leading: 1')
    rejects('not a key value')
    rejects('? complex')
    rejects('a: 1\n---\nb: 2')
    rejects('bad key!: 1')
  })

  test('error messages carry the line number', () => {
    expect(rejects('ok: 1\nbad: |\n  x')).toContain('line 2')
  })
})

describe('serializeFrontmatter', () => {
  test('round-trips every supported value', () => {
    const record = {
      name: 'pine-v6',
      description: 'Pine v6: syntax, pitfalls, #tags and more',
      text: 'plain text',
      numberLike: '42',
      boolLike: 'true',
      empty: '',
      spaced: ' padded ',
      multiline: 'a\nb',
      commas: 'a, b',
      version: 3,
      ratio: -1.25,
      flag: false,
      none: null,
      list: ['a', 'b c', 1, true, null, 'x, y', ''],
      emptyList: [],
      nested: { author: 'Jane', tags: ['p', 'q'], n: 2, quote: "it's" },
    }
    const text = serializeFrontmatter(record)
    expect(parse(text)).toEqual(record)
  })

  test('is deterministic and falls back to JSON outside the subset', () => {
    expect(serializeFrontmatter({ a: 1, b: 'x' })).toBe('a: 1\nb: x')
    expect(serializeFrontmatter({ deep: { x: { y: 1 } }, list: [{ k: 1 }], skip: undefined })).toBe(
      'deep:\n  x: {"y":1}\nlist: [{"k":1}]',
    )
  })
})

describe('parseSkillMarkdown', () => {
  const doc = (front: string, body = '# Body\n\nText.\n') => `---\n${front}\n---\n${body}`

  test('parses name, description, meta and body', () => {
    expect(
      parseSkillMarkdown(
        doc(
          'name: pine-v6\ndescription: Pine v6. Use when writing Pine.\nlicense: MIT\ntags: [a]',
          '\n\n# Pine\n\nBody.\n',
        ),
      ),
    ).toEqual({
      meta: {
        name: 'pine-v6',
        description: 'Pine v6. Use when writing Pine.',
        meta: { license: 'MIT', tags: ['a'] },
      },
      body: '# Pine\n\nBody.\n',
    })
  })

  test('no meta key without extra fields; BOM and CRLF are tolerated', () => {
    expect(parseSkillMarkdown('\uFEFF---\r\nname: a\r\ndescription: d\r\n---\r\nx\r\n')).toEqual({
      meta: { name: 'a', description: 'd' },
      body: 'x\n',
    })
    expect(parseSkillMarkdown('---\nname: a\ndescription: d\n---')).toEqual({
      meta: { name: 'a', description: 'd' },
      body: '',
    })
  })

  test('numeric names and descriptions are read as text', () => {
    expect(parseSkillMarkdown(doc('name: 404\ndescription: 12'))).toMatchObject({
      meta: { name: '404', description: '12' },
    })
  })

  test('errors', () => {
    const error = (text: string) => {
      const result = parseSkillMarkdown(text)
      expect('error' in result).toBe(true)
      return 'error' in result ? result.error : ''
    }
    expect(error('# no frontmatter')).toContain('---')
    expect(error('---\nname: a\ndescription: d\n')).toContain('not closed')
    expect(error(doc('description: d'))).toContain('name')
    expect(error(doc('name: Bad_Name\ndescription: d'))).toContain('must match')
    expect(error(doc('name: a--b\ndescription: d'))).toContain('must match')
    expect(error(doc(`name: ${'a'.repeat(65)}\ndescription: d`))).toContain('64')
    expect(error(doc('name: a'))).toContain('description')
    expect(error(doc('name: a\ndescription: ""'))).toContain('empty')
    expect(error(doc(`name: a\ndescription: ${'x'.repeat(1025)}`))).toContain('1024')
    expect(error(doc('name: a\ndescription: |\n  block'))).toContain('invalid frontmatter')
    expect(error(doc('name: [a]\ndescription: d'))).toContain('string')
    expect(error(42 as unknown as string)).toContain('text')
  })
})
