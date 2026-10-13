/**
 * The Remote sandbox connector (plan P44 D13): Python on a separate sandbox server
 * (`examples/sandbox-server`) instead of this machine. One connection per workspace (URL and a
 * bearer token stored as a secret); when an agent has it on, its `run_python` comes from here and
 * the Files & Sandbox connector does not add a second one (`connectors.ts`).
 */
import { probeRemoteSandbox, remoteSandbox } from '@eharness-examples/sandbox-server/client'
import { type AnyConnectorDefinition, defineConnector } from 'eharness/connectors'
import { ehMeta } from 'eharness/providers'
import { z } from 'zod'
import type { CodeRuntime } from './index.ts'

export const REMOTE_SANDBOX_ID = 'remote-sandbox'

interface RemoteSettings {
  url: string
  token: string
}

export interface RemoteStatus {
  host: string
  python: string | null
  pythonCommand: string
  isolated: boolean
  label: string
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Probe results are reused for a few seconds: activation of every agent would probe again. */
const recent = new Map<string, { at: number; value: Promise<RemoteStatus> }>()
const FRESH_MS = 15_000

export function probeStatus(
  settings: RemoteSettings,
  fetchFn: typeof fetch | undefined,
  timeoutMs = 5_000,
): Promise<RemoteStatus> {
  const key = `${settings.url}\n${settings.token}`
  const hit = recent.get(key)
  if (hit !== undefined && Date.now() - hit.at < FRESH_MS) return hit.value
  const value = probeRemoteSandbox({
    url: settings.url,
    token: settings.token,
    ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
    timeoutMs,
  }).then((info) => ({
    host: hostOf(settings.url),
    python: info.python,
    pythonCommand: info.pythonCommand ?? 'python3',
    isolated: info.isolation.isolated,
    label: info.isolation.label,
  }))
  recent.set(key, { at: Date.now(), value })
  value.catch(() => recent.delete(key))
  return value
}

export function remoteSandboxConnector(
  runtime: () => CodeRuntime | undefined,
): AnyConnectorDefinition {
  return defineConnector({
    id: REMOTE_SANDBOX_ID,
    version: '1',
    name: 'Remote sandbox',
    description:
      'Run Python on a separate sandbox server (examples/sandbox-server) instead of this machine.',
    icon: 'server',
    category: 'workspace',
    source: 'curated',
    auth: { type: 'none' },
    scopes: ['workspace'],
    // one remote sandbox per workspace; the tool name is fixed
    instances: 'single',
    toolPrefix: 'never',
    settings: z.object({
      url: z
        .string()
        .url()
        .meta({
          title: 'Server URL',
          description: 'Where the sandbox server listens, for example http://sandbox:4100.',
          ...ehMeta({ group: 'endpoint', placeholder: 'http://sandbox:4100' }),
        }),
      token: z
        .string()
        .min(8)
        .meta({
          title: 'Token',
          description: 'The SANDBOX_TOKEN of the server. Stored encrypted.',
          ...ehMeta({ group: 'auth', secret: true, widget: 'password' }),
        }),
    }),
    capabilities: [
      {
        id: 'run',
        title: 'Run Python remotely',
        description:
          'Run Python scripts over library files on the sandbox server; files the script creates or changes are saved to the library.',
        kind: 'external',
        tools: ['run_python'],
        defaultMode: 'ask',
      },
    ],
    scopeDefaults: { workspace: { defaultEnabled: false } },
    test: async (ctx) => {
      const s = ctx.settings as unknown as RemoteSettings
      try {
        const info = await probeRemoteSandbox({
          url: s.url,
          token: s.token,
          fetch: ctx.fetch,
          timeoutMs: 10_000,
        })
        return {
          ok: true,
          message: `Python ${info.python} · ${info.isolation.label}`,
          accountLabel: hostOf(s.url),
        }
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message.slice(0, 200)
              : 'Could not reach the sandbox server.',
        }
      }
    },
    activate: async (ctx) => {
      const code = runtime()
      if (code === undefined) return []
      const s = ctx.settings as unknown as RemoteSettings
      let pythonCommand = 'python3'
      try {
        pythonCommand = (await probeStatus(s, ctx.fetch, 3_000)).pythonCommand
      } catch {
        // unreachable now: the tool stays and reports the error when it runs
      }
      return code.remotePlugin({
        sandbox: () => remoteSandbox({ url: s.url, token: s.token, fetch: ctx.fetch }),
        pythonCommand,
        // the library access of a remote run: read and write like a local run of an agent that
        // may edit files (a delete never goes through code); program runs keep their authority
        tools: ['read_file', 'write_file', 'edit_file'],
      })
    },
  })
}
