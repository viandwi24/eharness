import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_OUTPUT_STYLES,
  createOutputStyles,
  loadOutputStyles,
  outputStyleInstruction,
} from '../src/app/output-styles.ts'
import { tempDir, writeFiles } from './helpers.ts'

describe('output styles', () => {
  test('built-ins', async () => {
    const root = await tempDir()
    const userDir = await tempDir()
    const styles = await createOutputStyles({ root, userDir, trusted: true }).styles()
    expect(styles.map((s) => s.name)).toEqual(['default', 'concise', 'explanatory', 'learning'])
    const all = await loadOutputStyles({ root, userDir, trusted: true })
    expect(outputStyleInstruction('default', all)).toBeUndefined()
    expect(outputStyleInstruction(undefined, all)).toBeUndefined()
    expect(outputStyleInstruction('nope', all)).toBeUndefined()
    expect(outputStyleInstruction('concise', all)).toContain('terse')
    expect(outputStyleInstruction('explanatory', all)).toContain('Insight')
    expect(outputStyleInstruction('learning', all)).toContain('TODO(human)')
    expect(BUILTIN_OUTPUT_STYLES.every((s) => s.description !== '')).toBe(true)
  })

  test('custom files: user, project (only when trusted), overrides, frontmatter', async () => {
    const root = await tempDir()
    const userDir = await tempDir()
    await writeFiles(userDir, {
      'output-styles/pirate.md':
        '---\nname: pirate\ndescription: Talk like a pirate\n---\nAnswer like a pirate.',
      'output-styles/concise.md': '---\ndescription: My concise\n---\nUser concise body.',
      'output-styles/empty.md': '---\nname: empty\n---\n',
    })
    await writeFiles(root, {
      '.coder/output-styles/formal.md': '---\ndescription: Formal\n---\nBe formal.',
      '.coder/output-styles/pirate.md':
        '---\nname: pirate\ndescription: Project pirate\n---\nProject pirate body.',
    })
    const untrusted = createOutputStyles({ root, userDir, trusted: false })
    expect((await untrusted.styles()).map((s) => s.name)).not.toContain('formal')
    expect(await untrusted.instruction('pirate')).toContain('Answer like a pirate.')

    const trusted = createOutputStyles({ root, userDir, trusted: true })
    const list = await trusted.styles()
    expect(list.find((s) => s.name === 'formal')?.description).toBe('Formal')
    expect(list.find((s) => s.name === 'pirate')?.description).toBe('Project pirate')
    expect(list.map((s) => s.name)).not.toContain('empty')
    expect(await trusted.instruction('pirate')).toBe('# Output style: pirate\nProject pirate body.')
    // a user file named like a built-in replaces it (name from the file name)
    expect(await trusted.instruction('concise')).toContain('User concise body.')
    expect(await trusted.has('formal')).toBe(true)
    expect(await trusted.has('nope')).toBe(false)
  })
})
