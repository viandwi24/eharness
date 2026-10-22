/**
 * Fills the Developer API, artifacts, browser profiles and uploads of a composed server through
 * the real routes and use cases (see `backup-world.ts` for the base world). The model of the
 * instance is swapped for a scripted one only for the `/v1` calls.
 */
import { scriptedModel } from 'eharness/testing'
import { libraryFs } from '../../src/infra/eh/library-fs.ts'
import type { Server } from '../../src/main.ts'
import type { BaseWorld } from './backup-world.ts'

export interface ApiWorld {
  /** The PLAIN API key (shown once at creation): authenticates `/v1` requests. */
  apiKey: string
  apiAgentId: string
  apiAgentSlug: string
  /** The second API agent (archived at the end). */
  archivedApiAgentId: string
  keyId: string
  revokedKeyId: string
  conversationId: string
  sharedArtifactId: string
  shareToken: string
  privateArtifactId: string
  binaryArtifactId: string
  browserProfileId: string
  uploadPaths: string[]
  uploadPath: string
}

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0xff, 0xfe, 0xfd,
])

const call = async (
  server: Server,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function ok<T>(res: Response, status: number, what: string): Promise<T> {
  if (res.status !== status) throw new Error(`${what}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export async function populateApi(server: Server, _world: BaseWorld): Promise<ApiWorld> {
  // --- Developer API: agents
  await server.app.request('/developer/agents') // warm-up of the owner surface
  const agent = await ok<{ id: string; slug: string }>(
    await call(server, 'POST', '/developer/agents', {
      name: 'Support desk',
      instructions: 'Answer support questions briefly. Ünïcode is fine: ✓',
      readFolders: ['/library/public/**'],
      writeFolder: '/library/tickets',
    }),
    201,
    'api agent',
  )
  const second = await ok<{ id: string; slug: string }>(
    await call(server, 'POST', '/developer/agents', {
      name: 'Old bot',
      instructions: 'Retired helper.',
    }),
    201,
    'second api agent',
  )

  // --- keys: one with limits, origins and expiry; one revoked
  const made = await ok<{ key: string; view: { id: string } }>(
    await call(server, 'POST', '/developer/keys', {
      name: 'Website',
      agents: [agent.slug, second.slug],
      dailyCostLimitUsd: 50,
      rateLimitPerMin: 120,
      origins: ['https://site.example', 'https://app.example'],
      expiresAt: Date.now() + 90 * 86_400_000,
    }),
    201,
    'api key',
  )
  const spare = await ok<{ key: string; view: { id: string } }>(
    await call(server, 'POST', '/developer/keys', { name: 'Old key', agents: [agent.slug] }),
    201,
    'spare key',
  )
  await ok(await call(server, 'POST', `/developer/keys/${spare.view.id}/revoke`), 200, 'revoke')

  // --- real /v1 calls with a scripted model: requests, calls and conversations
  const models = server.models as { resolve: (...a: unknown[]) => unknown }
  const original = models.resolve
  const script = scriptedModel([
    { text: 'One-shot answer.' },
    { text: 'Hello Ada.' },
    { text: 'Your name is Ada.' },
  ])
  models.resolve = () => script as never
  let conversationId: string
  try {
    const auth = { authorization: `Bearer ${made.key}` }
    await ok(
      await call(server, 'POST', `/v1/agents/${agent.slug}/run`, { input: 'Hi there' }, auth),
      200,
      'v1 run',
    )
    const conv = await call(
      server,
      'POST',
      '/v1/conversations',
      { agent: agent.slug, endUserId: 'user-42', metadata: { page: 'pricing' } },
      auth,
    )
    conversationId = (await ok<{ id: string }>(conv, 201, 'v1 conversation')).id
    for (const text of ['My name is Ada.', 'What is my name?'])
      await ok(
        await call(
          server,
          'POST',
          `/v1/conversations/${conversationId}/messages`,
          { text, stream: false },
          auth,
        ),
        200,
        'v1 message',
      )
  } finally {
    models.resolve = original as never
  }

  // --- uploads through the real route
  const uploadPaths: string[] = []
  const files: Array<[string, string, BlobPart]> = [
    ['notes ü.csv', 'text/csv', 'a,b\n1,2\n"é",ü\n'],
    ['pixel.png', 'image/png', PNG as BlobPart],
    ['data.json', 'application/json', JSON.stringify({ k: [1, null, 'ü'] })],
  ]
  for (const [name, type, content] of files) {
    const form = new FormData()
    form.set('file', new File([content], name, { type }))
    const res = await server.app.request('/library/files', { method: 'POST', body: form })
    uploadPaths.push((await ok<{ path: string }>(res, 201, 'upload')).path)
  }

  // --- artifacts: shared with a token (2 versions), private, binary
  const shared = (await server.artifacts.create({
    kind: 'html',
    title: 'Pricing page ✓',
    description: 'A shared page',
    files: [
      { path: 'index.html', content: '<html><body>one</body></html>' },
      { path: 'style.css', content: 'body{color:#333}' },
    ],
  } as never)) as { id: string; dir: string }
  const pub = await ok<{ shareUrl: string }>(
    await call(server, 'PATCH', `/artifacts/${shared.id}`, { visibility: 'public' }),
    200,
    'share artifact',
  )
  const shareToken = pub.shareUrl.split('/s/')[1] as string
  const agentFs = libraryFs(server.conn.sqlite, {
    agentId: 'populate-agent',
    onChange: (c) => server.artifacts.onLibraryChange(c),
  })
  await agentFs.write(`${shared.dir}/index.html`, '<html><body>two</body></html>')
  await server.artifacts.snapshotDirty('populate-agent')

  const priv = (await server.artifacts.create({
    kind: 'document',
    title: 'Private notes',
    files: [{ path: 'notes.md', content: '# Notes\nsecret plan' }],
  } as never)) as { id: string }
  const binary = (await server.artifacts.create({
    kind: 'image',
    title: 'Chart image',
    files: [{ path: 'chart.png', base64: Buffer.from(PNG).toString('base64') }],
    entry: 'chart.png',
  } as never)) as { id: string }

  // --- browser profile (manual: no browser is launched)
  const profile = await ok<{ id: string }>(
    await call(server, 'POST', '/browser/profiles', {
      name: 'Work browser',
      adapter: 'chrome',
      mode: 'manual',
      settings: {
        cdpUrl: 'ws://127.0.0.1:9/devtools/browser/populate',
        headers: { Authorization: 'Bearer populate-secret' },
      },
      allowDomains: ['example.com', 'docs.example.org'],
      trusted: true,
    }),
    201,
    'browser profile',
  )

  // archive the second API agent last: everything above needed it active
  await ok(await call(server, 'DELETE', `/developer/agents/${second.id}`), 200, 'archive agent')

  return {
    apiKey: made.key,
    apiAgentId: agent.id,
    apiAgentSlug: agent.slug,
    archivedApiAgentId: second.id,
    keyId: made.view.id,
    revokedKeyId: spare.view.id,
    conversationId,
    sharedArtifactId: shared.id,
    shareToken,
    privateArtifactId: priv.id,
    binaryArtifactId: binary.id,
    browserProfileId: profile.id,
    uploadPaths,
    uploadPath: uploadPaths[0] as string,
  }
}
