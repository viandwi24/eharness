import { describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import {
  BUILTIN_SLASH_COMMANDS,
  expandBody,
  expandSkill,
  loadCommands,
  parseCommandFile,
  splitArguments,
} from '../src/app/commands.ts'
import { loadConfig } from '../src/app/config.ts'
import { makeController, setup, tempDir, writeFiles } from './helpers.ts'

describe('custom commands', () => {
  test('frontmatter and body', () => {
    const parsed = parseCommandFile(
      '---\ndescription: "Run tests"\nargument-hint: [path]\nmodel: x\n---\nRun $ARGUMENTS\n',
    )
    expect(parsed.meta).toEqual({ description: 'Run tests', 'argument-hint': '[path]', model: 'x' })
    expect(parsed.body).toBe('Run $ARGUMENTS')
    expect(parseCommandFile('just text').body).toBe('just text')
  })

  test('names come from the path, project beats user, skills come last', async () => {
    const { root, config } = await setup({
      '.coder/commands/review.md': '---\ndescription: Project review\n---\nReview $ARGUMENTS',
      '.coder/commands/frontend/test.md': 'Test the frontend: $1 then $2',
      '.coder/skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF\n',
    })
    await writeFiles(config.userDir, {
      'commands/review.md': 'User review',
      'commands/mine.md': '# My command\nbody',
    })
    const { commands, warnings } = await loadCommands({
      root,
      userDir: config.userDir,
      trusted: true,
    })
    expect(warnings).toEqual([])
    const by = Object.fromEntries(commands.map((c) => [c.name, c]))
    expect(Object.keys(by).sort()).toEqual(['frontend:test', 'mine', 'pdf', 'review'])
    expect(by.review).toMatchObject({ source: 'project', description: 'Project review' })
    expect(by.mine).toMatchObject({ source: 'user', description: 'My command' })
    expect(by.pdf).toMatchObject({ source: 'skill', description: 'Work with PDFs' })
    expect(by['frontend:test']?.description).toBe('Test the frontend: $1 then $2')
  })

  test('project commands and skills load only when the project is trusted', async () => {
    const { root, config } = await setup({
      '.coder/commands/a.md': 'a',
      '.coder/skills/pdf/SKILL.md': '---\nname: pdf\ndescription: d\n---\nbody',
    })
    await writeFiles(config.userDir, { 'commands/u.md': 'u' })
    const { commands } = await loadCommands({ root, userDir: config.userDir, trusted: false })
    expect(commands.map((c) => c.name)).toEqual(['u'])
  })

  test('built-in names are skipped with a warning', async () => {
    const root = await tempDir()
    const userDir = await tempDir()
    await writeFiles(root, {
      '.coder/commands/help.md': 'x',
      '.coder/commands/ok.md': 'y',
      '.coder/skills/clear/SKILL.md': '---\nname: clear\ndescription: d\n---\nb',
    })
    const { commands, warnings } = await loadCommands({ root, userDir, trusted: true })
    expect(commands.map((c) => c.name)).toEqual(['ok'])
    expect(warnings.length).toBe(2)
    expect(warnings.join('\n')).toContain('/help is a built-in command')
    expect(BUILTIN_SLASH_COMMANDS).toContain('diff')
  })

  test('expansion: $ARGUMENTS, positional words, appended arguments', () => {
    expect(splitArguments('a "b c" d')).toEqual(['a', 'b c', 'd'])
    expect(expandBody('Fix $ARGUMENTS now', 'the bug')).toBe('Fix the bug now')
    expect(expandBody('first=$1 second=$2 third=$3', 'x "y z"')).toBe('first=x second=y z third=')
    expect(expandBody('No placeholders', 'extra words')).toBe(
      'No placeholders\n\nARGUMENTS: extra words',
    )
    expect(expandBody('No placeholders', '')).toBe('No placeholders')
    expect(expandSkill('pdf', '')).toBe('Use the skill "pdf" now.')
    expect(expandSkill('pdf', 'merge a b')).toBe(
      'Use the skill "pdf" (call load_skill first) for this request: merge a b',
    )
  })

  test('the controller lists and expands them; trust covers .coder/commands', async () => {
    const { controller } = await makeController({
      model: scriptedModel([]),
      files: {
        '.coder/commands/greet.md':
          '---\ndescription: Greet\nargument-hint: <name>\n---\nSay hi to $ARGUMENTS',
      },
      flags: { trustProject: true },
    })
    const list = await controller.commands()
    expect(list).toEqual([
      { name: 'greet', description: 'Greet', argumentHint: '<name>', source: 'project' },
    ])
    expect(await controller.expandCommand('greet', 'Ann')).toBe('Say hi to Ann')
    await expect(controller.expandCommand('nope', '')).rejects.toThrow('unknown command')
  })

  test('an untrusted project with commands reports them and does not list them', async () => {
    const { config } = await setup({ '.coder/commands/greet.md': 'hi' })
    expect(config.trusted).toBe(false)
    expect(config.untrusted).toContain('commands')
    const { controller } = await makeController({
      model: scriptedModel([]),
      files: { '.coder/commands/greet.md': 'hi' },
    })
    expect(await controller.commands()).toEqual([])
  })

  test('editing a command file after trusting makes the project untrusted again', async () => {
    const { root } = await setup({ '.coder/commands/a.md': 'one' }, { trustProject: true })
    expect((await loadConfig({ cwd: root })).trusted).toBe(true)
    await writeFiles(root, { '.coder/commands/a.md': 'two' })
    const again = await loadConfig({ cwd: root })
    expect(again.trusted).toBe(false)
    expect(again.untrusted).toContain('commands')
  })
})
