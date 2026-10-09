/** `parseCommand`: splitting, wrapper stripping, env assignments, complex forms and redirects. */
import { describe, expect, test } from 'bun:test'
import { parseCommand } from './command.ts'

const subs = (command: string): string[] => parseCommand(command).subcommands

describe('parseCommand: operators', () => {
  const table: Array<[string, string, string[]]> = [
    ['&&', 'a && b', ['a', 'b']],
    ['||', 'a || b', ['a', 'b']],
    [';', 'a; b', ['a', 'b']],
    ['|', 'a | b', ['a', 'b']],
    ['|&', 'a |& b', ['a', 'b']],
    ['&', 'a & b', ['a', 'b']],
    ['newline', 'a\nb', ['a', 'b']],
    ['crlf', 'a\r\nb', ['a', 'b']],
    ['mixed', 'a && b || c; d | e |& f & g\nh', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']],
  ]
  for (const [name, command, expected] of table) {
    test(`splits on ${name}`, () => {
      const parsed = parseCommand(command)
      expect(parsed.subcommands).toEqual(expected)
      expect(parsed.complex).toBe(false)
    })
  }

  test('operators inside quotes do not split', () => {
    expect(subs('echo "a && b"')).toEqual(['echo a && b'])
    expect(subs("echo 'a; b'")).toEqual(['echo a; b'])
    expect(subs('git commit -m "a;b"')).toEqual(['git commit -m a;b'])
  })

  test('an escaped newline continues the line', () => {
    expect(subs('echo a \\\n b')).toEqual(['echo a b'])
  })

  test('whitespace is normalised', () => {
    expect(subs('  ls    -la   ')).toEqual(['ls -la'])
  })

  test('a comment ends the command', () => {
    expect(subs('ls # nothing here && rm x')).toEqual(['ls'])
  })
})

describe('parseCommand: wrappers', () => {
  const table: Array<[string, string]> = [
    ['timeout 30 npm test', 'npm test'],
    ['timeout 1.5s npm test', 'npm test'],
    ['timeout -k 5 30 npm test', 'npm test'],
    ['timeout -s KILL 30 npm test', 'npm test'],
    ['time ls', 'ls'],
    ['nice -n 5 make', 'make'],
    ['nice -5 make', 'make'],
    ['nice make', 'make'],
    ['nohup sleep 1', 'sleep 1'],
    ['command ls', 'ls'],
    ['builtin echo hi', 'echo hi'],
    ['stdbuf -oL -e0 cat f', 'cat f'],
    ['noglob ls', 'ls'],
    ['time timeout 5 nice -n 1 nohup ls', 'ls'],
    ['xargs rm', 'rm'],
  ]
  for (const [command, expected] of table) {
    test(`strips: ${command}`, () => {
      expect(subs(command)).toEqual([expected])
    })
  }

  test('wrappers that cannot be stripped safely stay', () => {
    expect(subs('command -v ls')).toEqual(['command -v ls'])
    expect(subs('timeout npm test')).toEqual(['timeout npm test'])
  })

  test('bare xargs is stripped and reported; xargs with options is kept', () => {
    expect(parseCommand('xargs rm')).toMatchObject({ subcommands: ['rm'], xargs: true })
    expect(parseCommand('xargs -n1 rm')).toMatchObject({
      subcommands: ['xargs -n1 rm'],
      xargs: false,
    })
    expect(parseCommand('cat f | xargs grep x')).toMatchObject({
      subcommands: ['cat f', 'grep x'],
      xargs: true,
    })
  })

  test('each subcommand is stripped on its own', () => {
    expect(subs('time ls && nohup make')).toEqual(['ls', 'make'])
  })
})

describe('parseCommand: env assignments', () => {
  test('safe variables are dropped', () => {
    expect(subs('NODE_ENV=test bun test')).toEqual(['bun test'])
    expect(subs('CI=1 NO_COLOR=1 TZ=UTC bun test')).toEqual(['bun test'])
  })

  test('unsafe variables stay (they change what the command does)', () => {
    expect(subs('FOO=1 bun test')).toEqual(['FOO=1 bun test'])
    expect(subs('PATH=/tmp ls')).toEqual(['PATH=/tmp ls'])
    expect(subs('LD_PRELOAD=x ls')).toEqual(['LD_PRELOAD=x ls'])
  })

  test('safe ones before an unsafe one are dropped, the rest stays', () => {
    expect(subs('CI=1 FOO=1 bun test')).toEqual(['FOO=1 bun test'])
  })
})

describe('parseCommand: complex forms', () => {
  const complexForms: Array<[string, string]> = [
    ['command substitution', 'echo $(rm x)'],
    ['quoted command substitution', 'echo "$(ls)"'],
    ['backticks', 'echo `rm x`'],
    ['process substitution in', 'diff <(ls) b'],
    ['process substitution out', 'tee >(cat) x'],
    ['subshell', '(cd a && ls)'],
    ['heredoc', 'cat <<EOF\nhi\nEOF'],
    ['for loop', 'for i in 1 2; do echo $i; done'],
    ['while loop', 'while true; do ls; done'],
    ['if', 'if true; then ls; fi'],
    ['trailing &&', 'ls &&'],
    ['trailing |', 'ls |'],
    ['leading &&', '&& ls'],
    ['case separator', 'a ;; b'],
    ['unterminated quote', 'echo "unterminated'],
    ['empty', ''],
    ['blank', '   '],
  ]
  for (const [name, command] of complexForms) {
    test(`complex: ${name}`, () => {
      expect(parseCommand(command).complex).toBe(true)
    })
  }

  test('single-quoted substitution is plain text', () => {
    expect(parseCommand("echo '$(ls)'")).toMatchObject({
      subcommands: ['echo $(ls)'],
      complex: false,
    })
  })

  test('trailing & (background) is not complex', () => {
    expect(parseCommand('sleep 1 &')).toMatchObject({ subcommands: ['sleep 1'], complex: false })
  })

  test('substitutions are surfaced as subcommands', () => {
    const parsed = parseCommand('echo $(rm x)')
    expect(parsed.subcommands).toContain('rm x')
    expect(parseCommand('echo `rm x`').subcommands).toContain('rm x')
    expect(parseCommand('echo "$(git push)"').subcommands).toContain('git push')
  })

  test('nested substitutions are surfaced', () => {
    expect(parseCommand('echo $(echo $(rm x))').subcommands).toContain('rm x')
  })

  test('a substitution with several commands surfaces each', () => {
    const { subcommands } = parseCommand('echo $(a && b | c)')
    expect(subcommands).toEqual(expect.arrayContaining(['a', 'b', 'c']))
  })

  test('subshell and process-substitution contents are subcommands', () => {
    expect(subs('(cd a && ls)')).toEqual(['cd a', 'ls'])
    expect(subs('diff <(ls) b')).toContain('ls')
  })

  test('redirect targets inside substitutions are collected', () => {
    expect(parseCommand('echo $(echo hi > out.txt)').redirects).toContain('out.txt')
  })

  test('a complex flag is false for plain pipelines', () => {
    expect(parseCommand('a | b && c').complex).toBe(false)
  })
})

describe('parseCommand: redirects and inputs', () => {
  test('output redirects', () => {
    expect(parseCommand('echo hi > out.txt').redirects).toEqual(['out.txt'])
    expect(parseCommand('echo hi >> out.txt').redirects).toEqual(['out.txt'])
    expect(parseCommand('echo hi 2> err.txt').redirects).toEqual(['err.txt'])
    expect(parseCommand('ls &> all.txt').redirects).toEqual(['all.txt'])
    expect(parseCommand('echo hi >out.txt').redirects).toEqual(['out.txt'])
  })

  test('the redirect is not part of the subcommand', () => {
    expect(subs('echo hi > out.txt')).toEqual(['echo hi'])
    expect(subs('echo hi 2> err')).toEqual(['echo hi'])
  })

  test('fd duplication is not a file', () => {
    expect(parseCommand('ls 2>&1').redirects).toEqual([])
    expect(parseCommand('ls >&2').redirects).toEqual([])
    expect(parseCommand('echo hi >> a 2>&1').redirects).toEqual(['a'])
  })

  test('/dev/null is reported (callers filter it)', () => {
    expect(parseCommand('ls 2>/dev/null').redirects).toEqual(['/dev/null'])
  })

  test('tee arguments are redirects, flags are not', () => {
    expect(parseCommand('echo x | tee a b').redirects).toEqual(['a', 'b'])
    expect(parseCommand('echo x | tee -a log').redirects).toEqual(['log'])
  })

  test('input redirects', () => {
    expect(parseCommand('cat < in.txt')).toMatchObject({ subcommands: ['cat'], inputs: ['in.txt'] })
    expect(parseCommand('cat 0< in.txt').inputs).toEqual(['in.txt'])
    expect(parseCommand('cat < /etc/passwd').inputs).toEqual(['/etc/passwd'])
  })

  test('a redirect target that is not a plain word makes it complex', () => {
    expect(parseCommand('echo hi > $(echo x)').complex).toBe(true)
  })
})

describe('parseCommand: tokenizer (library implementation)', () => {
  test('a comment ends at the newline, not at the end of the text', () => {
    expect(subs('echo a # note\nrm -rf x')).toEqual(['echo a', 'rm -rf x'])
    expect(subs('echo a#b')).toEqual(['echo a#b'])
  })

  test('quotes inside quotes and escapes', () => {
    expect(subs(`echo "a'b"`)).toEqual(["echo a'b"])
    expect(subs(`echo 'a"b'`)).toEqual(['echo a"b'])
    expect(subs('echo "a\\"b"')).toEqual(['echo a"b'])
    expect(subs('echo a\\;b')).toEqual(['echo a;b'])
    expect(subs('echo a\\ b')).toEqual(['echo a b'])
    expect(subs("echo ''")).toEqual(['echo'])
  })

  test('$VAR is kept as text, so path checks can refuse it', () => {
    const command = 'cat $HOME/x $' + '{A}'
    expect(subs(command)).toEqual([command])
  })

  test('ANSI-C and locale quoting are complex (they can hide a path)', () => {
    expect(parseCommand("cat $'\\x2fetc/passwd'").complex).toBe(true)
    expect(parseCommand('cat $"/etc/passwd"').complex).toBe(true)
  })

  test('a digit is a file descriptor only when attached to the redirect', () => {
    expect(parseCommand('echo 2 > f')).toMatchObject({ subcommands: ['echo 2'], redirects: ['f'] })
    expect(parseCommand('echo 2> f')).toMatchObject({ subcommands: ['echo'], redirects: ['f'] })
  })

  test('operators without spaces', () => {
    expect(subs('a&&b||c;d|e')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(parseCommand('cat<in>out')).toMatchObject({
      subcommands: ['cat'],
      inputs: ['in'],
      redirects: ['out'],
    })
  })

  test('heredoc and here-string', () => {
    expect(parseCommand('cat <<-EOF\nx\nEOF').complex).toBe(true)
    expect(parseCommand('cat <<< hi').complex).toBe(false)
  })

  test('an unterminated quote or a lone backtick is complex', () => {
    expect(parseCommand("echo 'x").complex).toBe(true)
    expect(parseCommand('echo `x').complex).toBe(true)
    expect(parseCommand('echo "$(x"').complex).toBe(true)
  })

  test('an escaped substitution is plain text', () => {
    expect(parseCommand('echo \\$(x)').complex).toBe(true) // the `(` is still a group
    expect(parseCommand('echo "\\$(x)"').complex).toBe(false)
  })
})
