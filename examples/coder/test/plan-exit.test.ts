import { describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import type { ApprovalAnswer, PermissionMode } from '../src/contracts.ts'
import { makeController, nextPending } from './helpers.ts'

async function planTurn(answer: ApprovalAnswer, start: PermissionMode = 'plan') {
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'exit_plan_mode', input: { plan: '1. do it' } }] },
    { text: 'ok' },
  ])
  const { controller } = await makeController({ model, flags: { permissionMode: start } })
  const turn = controller.run('plan it', {
    onRun: (run) => void run.stream.cancel().catch(() => {}),
  })
  const request = await nextPending(controller.broker)
  expect(request.toolName).toBe('exit_plan_mode')
  controller.broker.answer(request.id, answer)
  const result = await turn
  return { controller, model, result }
}

describe('plan approval modes', () => {
  test('approving with acceptEdits switches to acceptEdits and offers edit tools', async () => {
    const { controller, model, result } = await planTurn({ approved: true, mode: 'acceptEdits' })
    expect(result.stop).toBe('complete')
    expect(controller.permissions.mode).toBe('acceptEdits')
    const tools = ((model.calls.at(-1)?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)
    expect(tools).toContain('edit_file')
  })

  test('approving with default switches to default even when plan was entered from acceptEdits', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'exit_plan_mode', input: { plan: 'p' } }] },
      { text: 'ok' },
    ])
    const { controller } = await makeController({ model, flags: { permissionMode: 'acceptEdits' } })
    controller.permissions.setMode('plan')
    const turn = controller.run('plan', {
      onRun: (run) => void run.stream.cancel().catch(() => {}),
    })
    const request = await nextPending(controller.broker)
    controller.broker.answer(request.id, { approved: true, mode: 'default' })
    await turn
    expect(controller.permissions.mode).toBe('default')
  })

  test('approving without a mode returns to the mode before plan mode', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'exit_plan_mode', input: { plan: 'p' } }] },
      { text: 'ok' },
    ])
    const { controller } = await makeController({ model, flags: { permissionMode: 'acceptEdits' } })
    controller.permissions.setMode('plan')
    const turn = controller.run('plan', {
      onRun: (run) => void run.stream.cancel().catch(() => {}),
    })
    const request = await nextPending(controller.broker)
    controller.broker.answer(request.id, { approved: true })
    await turn
    expect(controller.permissions.mode).toBe('acceptEdits')
  })

  test('"No, keep planning" (a denial with feedback) stays in plan mode and the model sees it', async () => {
    const { controller, model, result } = await planTurn({
      approved: false,
      feedback: 'add a test step',
    })
    expect(result.stop).toBe('complete')
    expect(controller.permissions.mode).toBe('plan')
    expect(JSON.stringify(model.prompts.at(-1))).toContain('add a test step')
  })

  test('a stale chosen mode does not leak into the next plan', async () => {
    const { controller } = await planTurn({ approved: true, mode: 'acceptEdits' })
    controller.permissions.setMode('default')
    controller.permissions.setMode('plan')
    const engine = controller.permissions as unknown as { planExitMode(): unknown }
    expect(engine.planExitMode()).toBeUndefined()
  })
})
