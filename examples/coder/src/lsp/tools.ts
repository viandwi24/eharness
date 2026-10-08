/** The `lsp` agent tool: code intelligence from language servers, formatted as plain text. */
import { tool } from 'ai'
import { z } from 'zod/v4'
import type { LspLocation, LspManager } from './manager.ts'

const MAX_DIAGNOSTICS = 100
const MAX_LOCATIONS = 100
const MAX_SYMBOLS = 200
const MAX_HOVER_CHARS = 4000

const OPERATIONS = [
  'definition',
  'references',
  'hover',
  'diagnostics',
  'symbols',
  'workspace_symbols',
] as const

function formatLocation(l: LspLocation): string {
  return `${l.path}:${l.line}:${l.character}${l.text ? `  ${l.text}` : ''}`
}

function capped<T>(items: T[], max: number, noun: string): { shown: T[]; note: string } {
  return {
    shown: items.slice(0, max),
    note: items.length > max ? `\n... ${items.length - max} more ${noun} not shown` : '',
  }
}

/**
 * Build the `lsp` tool over a manager.
 *
 * @param manager The manager from `createLspManager`.
 */
export function createLspTools(manager: LspManager): { lsp: ReturnType<typeof makeLspTool> } {
  return { lsp: makeLspTool(manager) }
}

function makeLspTool(manager: LspManager) {
  return tool({
    description:
      'Code intelligence from the project language server. Prefer this over grep for go-to-definition, find-references and type errors when a server exists for the file type. ' +
      'Operations: definition / references / hover (need path, line, character; 1-based), diagnostics (path: errors and warnings of a file), ' +
      'symbols (path: outline of a file), workspace_symbols (query, optional path to pick the language). Paths are virtual ("/src/a.ts").',
    inputSchema: z.object({
      operation: z.enum(OPERATIONS),
      path: z.string().optional().describe('Virtual file path, e.g. "/src/index.ts".'),
      line: z.number().int().optional().describe('1-based line.'),
      character: z.number().int().optional().describe('1-based column.'),
      query: z.string().optional().describe('Symbol name filter for workspace_symbols.'),
    }),
    metadata: { risk: 'read' },
    execute: async ({ operation, path, line, character, query }): Promise<string> => {
      try {
        if (operation === 'workspace_symbols') {
          if (query === undefined) return 'ERROR: workspace_symbols needs `query`'
          const items = await manager.workspaceSymbols(query, path)
          if (items.length === 0) return `No symbols match "${query}".`
          const { shown, note } = capped(items, MAX_SYMBOLS, 'symbols')
          return (
            shown
              .map(
                (s) =>
                  `${s.kind} ${s.name}${s.container ? ` (in ${s.container})` : ''}  ${s.path ?? ''}:${s.line}`,
              )
              .join('\n') + note
          )
        }
        if (!path) return `ERROR: ${operation} needs \`path\``
        if (operation === 'diagnostics') {
          const items = await manager.diagnostics(path)
          if (items.length === 0) return `No diagnostics for ${path}.`
          const { shown, note } = capped(items, MAX_DIAGNOSTICS, 'diagnostics')
          return (
            shown
              .map((d) => {
                const tag = [d.source, d.code].filter((x) => x !== undefined && x !== '').join(' ')
                return `${d.path}:${d.line}:${d.character} ${d.severity} ${d.message.replace(/\s*\n\s*/g, ' ')}${tag ? ` (${tag})` : ''}`
              })
              .join('\n') + note
          )
        }
        if (operation === 'symbols') {
          const items = await manager.symbols(path)
          if (items.length === 0) return `No symbols in ${path}.`
          const { shown, note } = capped(items, MAX_SYMBOLS, 'symbols')
          return (
            shown.map((s) => `${'  '.repeat(s.depth)}${s.kind} ${s.name}  :${s.line}`).join('\n') +
            note
          )
        }
        if (line === undefined || character === undefined) {
          return `ERROR: ${operation} needs \`line\` and \`character\` (1-based)`
        }
        if (operation === 'hover') {
          const text = await manager.hover(path, line, character)
          if (!text) return `No hover information at ${path}:${line}:${character}.`
          return text.length > MAX_HOVER_CHARS ? `${text.slice(0, MAX_HOVER_CHARS)}\n...` : text
        }
        const locs =
          operation === 'definition'
            ? await manager.definition(path, line, character)
            : await manager.references(path, line, character)
        if (locs.length === 0) {
          return `No ${operation === 'definition' ? 'definition' : 'references'} found at ${path}:${line}:${character}.`
        }
        const { shown, note } = capped(locs, MAX_LOCATIONS, 'locations')
        return shown.map(formatLocation).join('\n') + note
      } catch (error) {
        return `ERROR: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
