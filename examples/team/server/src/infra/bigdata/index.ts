/**
 * Big-data toolkit wiring (decision D7/D8): the connector that offers the tools and the hook that
 * builds its plugin. `agent-factory.ts` installs the hook, `connector-catalog.ts` lists the connector.
 */
import type { Database } from 'bun:sqlite'
import {
  type BuiltinInput,
  type CapabilityDef,
  type ConnectorActivation,
  defineConnector,
} from 'eharness/connectors'
import type { ProgramStore } from '../../app/ports.ts'
import type { Collector } from '../../domain/collectors.ts'
import { type LibraryChange, libraryFs } from '../eh/library-fs.ts'
import { programPathAccess } from './authority.ts'
import { type CodeRunnerOptions, createCodeRunner } from './code-sandbox.ts'
import { BIGDATA_TOOLS, bigData } from './plugin.ts'

export type { CodeRunnerOptions } from './code-sandbox.ts'
export { communityFixture } from './fixture-collector.ts'

/** Configuration of the toolkit (`ServerConfig.bigData`). */
export interface BigDataConfig {
  /** The sources `ingest_source` knows. Default: none (`TEAM_DEMO_COLLECTOR=1` adds the fixture). */
  collectors?: readonly Collector[]
  /** Limits and sandbox policy of `run_code`. */
  runner?: CodeRunnerOptions
}

export type BigDataHook = (agentId: string, input: BuiltinInput) => ConnectorActivation

export function createBigDataHook(deps: {
  sqlite: Database
  programs: Pick<ProgramStore, 'get'>
  onFileChange?: ((change: LibraryChange) => void) | undefined
  config?: BigDataConfig | undefined
}): BigDataHook {
  const runner = createCodeRunner(deps.config?.runner)
  const access = programPathAccess(deps.programs)
  return (agentId, input) =>
    bigData({
      fs: libraryFs(deps.sqlite, {
        agentId,
        ...(deps.onFileChange ? { onChange: deps.onFileChange } : {}),
      }),
      access,
      collectors: () => deps.config?.collectors ?? [],
      runner,
      tools: input.tools,
    })
}

const cap = (
  id: string,
  title: string,
  description: string,
  tools: readonly string[],
): CapabilityDef => ({
  id,
  title,
  description,
  kind: 'write',
  tools: [...tools],
  defaultMode: 'allow',
})

/** The "Data work" connector: off for everyone until an agent (a program's agent) switches it on. */
export function bigDataConnector(
  hook: () => BigDataHook | undefined,
): ReturnType<typeof defineConnector> {
  return defineConnector({
    id: 'bigdata',
    version: '1',
    name: 'Data work',
    description:
      'Collect big data sources and work on them in chunks: sandboxed code over library files, source ingest and a resumable work manifest. For program runs.',
    icon: 'database',
    category: 'workspace',
    source: 'builtin',
    auth: { type: 'none' },
    scopes: ['workspace'],
    instances: 'single',
    capabilities: [
      cap('code', 'Run code', 'Run sandboxed JavaScript over library files.', BIGDATA_TOOLS.code),
      cap(
        'ingest',
        'Ingest a source',
        'Pull new items of a data source into the library.',
        BIGDATA_TOOLS.ingest,
      ),
      cap(
        'manifest',
        'Track chunked work',
        'Keep a resumable manifest of chunks.',
        BIGDATA_TOOLS.manifest,
      ),
    ],
    scopeDefaults: { workspace: { defaultEnabled: false } },
    activate: (ctx) =>
      hook()?.(ctx.agent.id, {
        tools: ctx.tools,
        modes: ctx.modes,
        capabilities: ctx.capabilities,
      }) ?? [],
  })
}
