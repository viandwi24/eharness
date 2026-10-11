/**
 * An attachment of the user's chat message reaches the delegated role agent: the lead is told the
 * path of the upload (`inputFiles.describe`) and passes it in `agent({ files })`, which becomes a
 * file part of the child's first message (spec 20 §2.4). Scripted models only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { type ModelConfig, scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs } from './support/http.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function start(script: Record<'lead' | 'researcher', ScriptedStepInput[]>) {
  const models = Object.fromEntries(
    Object.entries(script).map(([slug, steps]) => [slug, scriptedModel(steps)]),
  )
  const config: ModelConfig = {
    ...scriptedModelConfig(scriptedModel([]) as never),
    resolve: (id) =>
      (models[(id ?? '').replace('m-', '')] ?? scriptedModel([{ text: 'unexpected' }])) as never,
  }
  const server = compose({
    dbFile: ':memory:',
    models: config,
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  return { server, models }
}

async function sendPhoto(server: Server): Promise<string> {
  const form = new FormData()
  form.set(
    'file',
    new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' }),
  )
  const up = await server.app.request('/library/files', { method: 'POST', body: form })
  const file = (await up.json()) as { url: string; path: string }
  const res = await server.app.request(
    '/sessions/dm:lead/chat',
    postAs('dm:lead', {
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [
            { type: 'text', text: 'what is on this photo?' },
            { type: 'file', mediaType: 'image/png', filename: 'photo.png', url: file.url },
          ],
        },
      ],
    }),
  )
  const body = await res.text()
  expect({ status: res.status, body: res.status === 200 ? '' : body }).toEqual({
    status: 200,
    body: '',
  })
  return file.path
}

const delegateWith = (files: string[]) => ({
  toolName: 'agent',
  toolCallId: 'call-1',
  input: {
    subagent_type: 'researcher',
    description: 'Look at photo',
    prompt: 'Describe the attached photo.',
    run_in_background: false,
    files,
  },
})

describe('delegating an attachment', () => {
  test('the lead sees the upload path and the child receives the file', async () => {
    const { server, models } = start({ lead: [], researcher: [{ text: 'A cat.' }] })
    // the path is only known after the upload: the lead script reads it from its own prompt
    models.lead = scriptedModel([
      (call) => {
        const text = JSON.stringify(call.prompt)
        const path = /path \\"(\/uploads\/[^"\\]+)\\"/.exec(text)?.[1]
        if (path === undefined) throw new Error('no attachment path in the lead prompt')
        return { toolCalls: [delegateWith([path])] }
      },
      { text: 'It is a cat.' },
    ])
    const path = await sendPhoto(server)
    expect(path.startsWith('/uploads/')).toBe(true)
    await sleep(50)
    const child = JSON.stringify(models.researcher?.prompts[0])
    expect(child).toContain('Describe the attached photo.')
    expect(child).toContain('image/png')
  })

  test('a missing or foreign path is a readable error and no child starts', async () => {
    const { server, models } = start({
      lead: [
        { toolCalls: [delegateWith(['/uploads/2020-01-01/none.png'])] },
        { text: 'It failed.' },
      ],
      researcher: [{ text: 'never' }],
    })
    await sendPhoto(server)
    await sleep(50)
    expect(models.researcher?.calls).toHaveLength(0)
    const stored = JSON.stringify(
      await (await server.app.request('/sessions/dm:lead/messages')).json(),
    )
    expect(stored).toContain('does not exist')
  })
})
