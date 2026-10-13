/**
 * Artifacts wiring: the "Artifacts" connector (built in, on for every agent by default) and the hook
 * that builds its plugin. `connector-catalog.ts` lists the connector, `agent-factory.ts` installs the hook.
 */
import {
  type BuiltinInput,
  type CapabilityDef,
  type ConnectorActivation,
  defineConnector,
} from 'eharness/connectors'
import type { ProgramStore } from '../../app/ports.ts'
import { programPathAccess } from '../bigdata/authority.ts'
import type { ChannelGateway } from '../channels/index.ts'
import { ARTIFACT_TOOLS, type ArtifactDecisions, artifacts } from './plugin.ts'
import type { ArtifactService } from './service.ts'

export type { ArtifactDecisions } from './plugin.ts'
export type { ArtifactService } from './service.ts'
export { createArtifactService } from './service.ts'

export type ArtifactsHook = (agentSlugOrId: string, input: BuiltinInput) => ConnectorActivation

export interface ArtifactsHookDeps {
  service: ArtifactService
  programs: Pick<ProgramStore, 'get'>
  agentOf: (slug: string) => { id: string; name: string } | undefined
  channels: () => ChannelGateway | undefined
  decisions: () => ArtifactDecisions | undefined
}

export function createArtifactsHook(deps: ArtifactsHookDeps): ArtifactsHook {
  const access = programPathAccess(deps.programs)
  return (_agent, input) =>
    artifacts({
      service: deps.service,
      agentOf: deps.agentOf,
      channels: deps.channels,
      access,
      decisions: deps.decisions,
      tools: input.tools,
    })
}

const cap = (
  id: string,
  title: string,
  description: string,
  kind: CapabilityDef['kind'],
  tools: readonly string[],
): CapabilityDef => ({ id, title, description, kind, tools: [...tools], defaultMode: 'allow' })

/** The Artifacts connector: pages, documents, images, diagrams, tables and code the person can open and share. */
export function artifactsConnector(
  hook: () => ArtifactsHook | undefined,
): ReturnType<typeof defineConnector> {
  return defineConnector({
    id: 'artifacts',
    version: '1',
    name: 'Artifacts',
    description:
      'Create pages, documents, images, diagrams and tables the person can open next to the chat, version, export and share.',
    icon: 'browser',
    category: 'workspace',
    source: 'builtin',
    auth: { type: 'none' },
    scopes: ['workspace'],
    instances: 'single',
    capabilities: [
      cap(
        'create',
        'Create artifacts',
        'Create an artifact from text, files or a library folder; edit it with the file tools.',
        'write',
        ARTIFACT_TOOLS.create,
      ),
      cap('read', 'Find artifacts', 'List and look up artifacts.', 'read', ARTIFACT_TOOLS.read),
      cap(
        'share',
        'Change who can open',
        'Make an artifact public or private. Who may publish is checked in code: the web user and chat owners and admins; autonomous runs ask the owner.',
        'write',
        ARTIFACT_TOOLS.share,
      ),
    ],
    scopeDefaults: { workspace: { defaultEnabled: true } },
    activate: (ctx) =>
      hook()?.(ctx.agent.id, {
        tools: ctx.tools,
        modes: ctx.modes,
        capabilities: ctx.capabilities,
      }) ?? [],
  })
}
