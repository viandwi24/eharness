/** The code runtime probes the OS sandbox: bubblewrap that cannot create namespaces means "not isolated", never "every run fails". */
import { expect, test } from 'bun:test'
import { codeConfigFromEnv, createCodeRuntime } from '../src/infra/code/index.ts'

const config = (): ReturnType<typeof codeConfigFromEnv> => ({
  ...codeConfigFromEnv({ TEAM_CODE_DRIVER: 'local', TEAM_CODE_PYTHON: 'python3' }, ':memory:'),
  driver: 'local',
})

test('bubblewrap that cannot create a namespace: not isolated, says why, warns at boot', async () => {
  const warnings: string[] = []
  const runtime = createCodeRuntime(config(), {
    programs: () => undefined,
    warn: (m) => warnings.push(m),
    probe: async () => ({
      kind: 'bubblewrap',
      ok: false,
      reason: 'bwrap: No permissions to create a new namespace',
    }),
  })
  await runtime.start()
  const info = await runtime.info()
  expect(info.isolated).toBe(false)
  expect(info.label).toContain('does not allow user namespaces')
  expect(info.label).toContain('Remote sandbox')
  expect(warnings.some((w) => w.includes('without isolation'))).toBe(true)
})

test('a working sandbox is isolated', async () => {
  const runtime = createCodeRuntime(config(), {
    programs: () => undefined,
    probe: async () => ({ kind: 'bubblewrap', ok: true, path: '/usr/bin/bwrap' }),
  })
  expect((await runtime.info()).isolated).toBe(true)
})
