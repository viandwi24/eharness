import { afterEach, describe, expect, test } from 'bun:test'
import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { Footer } from '../src/ui/Footer.tsx'
import { backgroundIsLight, color, setTheme, themeName, useTheme } from '../src/ui/theme.ts'

const saved = { ...process.env }
afterEach(() => {
  process.env.COLORFGBG = saved.COLORFGBG as string
  if (saved.COLORFGBG === undefined) delete process.env.COLORFGBG
  if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = saved.NO_COLOR
  setTheme('dark')
})

describe('theme', () => {
  test('dark and light palettes switch in place', () => {
    delete process.env.NO_COLOR
    setTheme('dark')
    expect(themeName()).toBe('dark')
    const dark = color.dim
    setTheme('light')
    expect(themeName()).toBe('light')
    expect(color.dim).not.toBe(dark)
    expect(color.accent).toBe('#D97757')
    expect(color.addedBg).toBe('#D4F0DA')
  })
  test('auto follows COLORFGBG', () => {
    delete process.env.NO_COLOR
    process.env.COLORFGBG = '0;15'
    setTheme('auto')
    expect(themeName()).toBe('light')
    process.env.COLORFGBG = '15;0'
    setTheme('auto')
    expect(themeName()).toBe('dark')
    delete process.env.COLORFGBG
    setTheme('auto')
    expect(themeName()).toBe('dark')
    expect(backgroundIsLight({ COLORFGBG: '0;default;7' })).toBe(true)
  })
  test('NO_COLOR wins', () => {
    process.env.NO_COLOR = '1'
    setTheme('light')
    expect(color.accent).toBeUndefined()
    expect(color.dim).toBeUndefined()
  })
  test('useTheme re-renders subscribers', async () => {
    delete process.env.NO_COLOR
    setTheme('dark')
    let renders = 0
    function Probe() {
      useTheme()
      renders++
      return <Text>x</Text>
    }
    const app = render(<Probe />)
    const before = renders
    setTheme('light')
    await new Promise((r) => setTimeout(r, 20))
    expect(renders).toBeGreaterThan(before)
    app.unmount()
  })
  test('footer renders under the light theme', () => {
    setTheme('light')
    const app = render(<Footer mode="plan" model="a/b" thinking="low" />)
    expect(app.lastFrame()).toContain('plan mode')
    app.unmount()
  })
})
