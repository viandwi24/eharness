/**
 * LSP manager: picks a language server per file extension, starts it lazily, keeps documents
 * open and in sync with the disk, and exposes position queries returning virtual paths.
 */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { delimiter, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CoderSettings } from '../contracts.ts'
import { LspClient, type LspDiagnostic, type LspRange } from './client.ts'

export type LspServers = NonNullable<CoderSettings['lsp']>

const DIAGNOSTICS_WAIT_MS = 3000

const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.json': 'json',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.lua': 'lua',
  '.sh': 'shellscript',
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

/** A resolved location: virtual path when inside a mount, otherwise the real path. */
export interface LspLocation {
  path: string
  /** 1-based. */
  line: number
  /** 1-based. */
  character: number
  /** The source line at the location (trimmed), when readable. */
  text?: string
}

export interface LspDiagnosticItem extends LspLocation {
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source?: string
  code?: string | number
}

export interface LspSymbolItem {
  name: string
  kind: string
  depth: number
  line: number
  /** Present for workspace symbols. */
  path?: string
  container?: string
}

export interface LspServerStatus {
  name: string
  command: string[]
  extensions: string[]
  state: 'idle' | 'running' | 'failed'
  detail?: string
}

export interface LspManager {
  /** True when at least one server is configured or detected. */
  readonly available: boolean
  /** Server name serving a virtual path, or null. */
  serverFor(path: string): string | null
  definition(path: string, line: number, character: number): Promise<LspLocation[]>
  references(path: string, line: number, character: number): Promise<LspLocation[]>
  /** Hover text (markdown trimmed), or '' when the server has nothing. */
  hover(path: string, line: number, character: number): Promise<string>
  diagnostics(path: string): Promise<LspDiagnosticItem[]>
  /** Diagnostics of every document opened so far. */
  allDiagnostics(): Promise<LspDiagnosticItem[]>
  symbols(path: string): Promise<LspSymbolItem[]>
  /** `path` selects the server (any file of that language); default: the first server. */
  workspaceSymbols(query: string, path?: string): Promise<LspSymbolItem[]>
  status(): LspServerStatus[]
  close(): Promise<void>
}

export interface LspManagerOptions {
  servers?: CoderSettings['lsp']
  /** Real project root (server cwd and workspace root). */
  root: string
  toReal(virtualPath: string): Promise<string | null>
  toVirtual(realPath: string): string | null
  /** Override the 3 s diagnostics wait (tests). */
  diagnosticsWaitMs?: number
  /** Override the 10 s request timeout (tests). */
  requestTimeoutMs?: number
}

/** Error with a message safe to show to the model. */
export class LspError extends Error {}

function findExecutable(name: string, root: string): string | null {
  const dirs = [join(root, 'node_modules', '.bin'), ...(process.env.PATH ?? '').split(delimiter)]
  const names = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name]
  for (const dir of dirs) {
    if (!dir) continue
    for (const n of names) if (existsSync(join(dir, n))) return join(dir, n)
  }
  return null
}

/** Servers used when settings have none: TypeScript/JavaScript, only when the binary exists. */
export function defaultServers(root: string): LspServers {
  const bin = findExecutable('typescript-language-server', root)
  return bin ? { typescript: { command: [bin, '--stdio'], extensions: TS_EXTENSIONS } } : {}
}

const SYMBOL_KINDS = [
  '',
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
]

interface OpenDoc {
  version: number
  mtimeMs: number
  text: string
}

interface Entry {
  name: string
  command: string[]
  extensions: string[]
  client?: LspClient
  starting?: Promise<LspClient>
  docs: Map<string, OpenDoc>
  restarts: number
  failure?: string
}

interface Located {
  entry: Entry
  client: LspClient
  uri: string
  real: string
}

const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'] as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Create the manager. Nothing is spawned until the first query. */
export function createLspManager(options: LspManagerOptions): LspManager {
  const configured = options.servers && Object.keys(options.servers).length > 0
  const servers = configured ? (options.servers as LspServers) : defaultServers(options.root)
  const entries: Entry[] = Object.entries(servers).map(([name, s]) => ({
    name,
    command: s.command,
    extensions: s.extensions.map((e) => e.toLowerCase()),
    docs: new Map(),
    restarts: 0,
  }))
  const rootUri = pathToFileURL(options.root).href
  const diagWait = options.diagnosticsWaitMs ?? DIAGNOSTICS_WAIT_MS
  let closed = false

  const entryFor = (path: string): Entry | undefined => {
    const ext = extname(path).toLowerCase()
    return entries.find((e) => e.extensions.includes(ext) || e.extensions.includes(ext.slice(1)))
  }

  async function connect(entry: Entry): Promise<LspClient> {
    if (closed) throw new LspError('the language server manager is closed')
    if (entry.client?.alive) return entry.client
    if (entry.starting) return entry.starting
    if (entry.client && !entry.client.alive) {
      // crashed: restart lazily, once
      if (entry.restarts >= 1) {
        throw new LspError(
          `language server "${entry.name}" crashed and was already restarted once: ${entry.failure ?? entry.client.deathReason ?? 'unknown error'}`,
        )
      }
      entry.restarts++
      entry.docs.clear()
    } else if (entry.failure && !entry.client) {
      throw new LspError(`language server "${entry.name}" failed to start: ${entry.failure}`)
    }
    entry.starting = LspClient.start({
      command: entry.command,
      cwd: options.root,
      rootUri,
      requestTimeoutMs: options.requestTimeoutMs,
    }).then(
      (client) => {
        entry.client = client
        entry.starting = undefined
        entry.failure = undefined
        return client
      },
      (error: unknown) => {
        entry.starting = undefined
        entry.client = undefined
        entry.failure = messageOf(error)
        throw new LspError(`language server "${entry.name}" failed to start: ${entry.failure}`)
      },
    )
    return entry.starting
  }

  /** Open (or re-sync) a document; returns what is needed to query it. */
  async function open(path: string, waitDiagnostics = false): Promise<Located> {
    const entry = entryFor(path)
    if (!entry) {
      const ext = extname(path) || path
      throw new LspError(
        `no language server configured for "${ext}" files${entries.length ? ` (configured: ${entries.map((e) => e.name).join(', ')})` : ''}`,
      )
    }
    const real = await options.toReal(path)
    if (real === null) throw new LspError(`path outside the workspace: ${path}`)
    let text: string
    let mtimeMs: number
    try {
      ;[text, mtimeMs] = await Promise.all([
        readFile(real, 'utf8'),
        stat(real).then((s) => s.mtimeMs),
      ])
    } catch (error) {
      throw new LspError(`cannot read ${path}: ${messageOf(error)}`)
    }
    const client = await connect(entry)
    const uri = pathToFileURL(real).href
    const doc = entry.docs.get(uri)
    const before = client.diagnosticsSeq(uri)
    let sent = false
    if (!doc) {
      entry.docs.set(uri, { version: 1, mtimeMs, text })
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: LANGUAGE_IDS[extname(real).toLowerCase()] ?? extname(real).slice(1),
          version: 1,
          text,
        },
      })
      sent = true
    } else if (doc.mtimeMs !== mtimeMs || doc.text !== text) {
      doc.version++
      doc.mtimeMs = mtimeMs
      doc.text = text
      client.notify('textDocument/didChange', {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      })
      sent = true
    }
    if (sent && waitDiagnostics) await client.waitForDiagnostics(uri, before, diagWait)
    return { entry, client, uri, real }
  }

  async function ask(located: Located, method: string, params: unknown): Promise<unknown> {
    try {
      return await located.client.request(method, params)
    } catch (error) {
      throw new LspError(`language server "${located.entry.name}": ${messageOf(error)}`)
    }
  }

  const lineCache = new Map<string, { mtime: number; lines: string[] }>()
  async function lineText(real: string, line0: number): Promise<string | undefined> {
    try {
      const mtime = (await stat(real)).mtimeMs
      let cached = lineCache.get(real)
      if (!cached || cached.mtime !== mtime) {
        cached = { mtime, lines: (await readFile(real, 'utf8')).split(/\r?\n/) }
        lineCache.set(real, cached)
        if (lineCache.size > 50) lineCache.delete(lineCache.keys().next().value as string)
      }
      return cached.lines[line0]?.trim().slice(0, 200)
    } catch {
      return undefined
    }
  }

  async function locate(uri: string, range: LspRange): Promise<LspLocation> {
    let real = uri
    try {
      real = fileURLToPath(uri)
    } catch {
      return { path: uri, line: range.start.line + 1, character: range.start.character + 1 }
    }
    const text = await lineText(real, range.start.line)
    return {
      path: options.toVirtual(real) ?? real,
      line: range.start.line + 1,
      character: range.start.character + 1,
      ...(text !== undefined ? { text } : {}),
    }
  }

  async function locations(raw: unknown): Promise<LspLocation[]> {
    if (!raw) return []
    const list = Array.isArray(raw) ? raw : [raw]
    const out: LspLocation[] = []
    for (const item of list as Array<Record<string, unknown>>) {
      // Location | LocationLink
      const uri = (item.uri ?? item.targetUri) as string | undefined
      const range = (item.range ?? item.targetSelectionRange ?? item.targetRange) as
        | LspRange
        | undefined
      if (uri && range) out.push(await locate(uri, range))
    }
    return out
  }

  async function diagnosticItems(
    uri: string,
    diags: LspDiagnostic[],
  ): Promise<LspDiagnosticItem[]> {
    const out: LspDiagnosticItem[] = []
    for (const d of diags) {
      const loc = await locate(uri, d.range)
      out.push({
        ...loc,
        severity: SEVERITY[d.severity ?? 1] ?? 'error',
        message: d.message,
        ...(d.source ? { source: d.source } : {}),
        ...(d.code !== undefined ? { code: d.code } : {}),
      })
    }
    return out
  }

  function hoverText(contents: unknown): string {
    const one = (c: unknown): string => {
      if (typeof c === 'string') return c
      if (c && typeof c === 'object') {
        const o = c as { value?: string; language?: string }
        if (typeof o.value === 'string')
          return o.language ? `\`\`\`${o.language}\n${o.value}\n\`\`\`` : o.value
      }
      return ''
    }
    const text = Array.isArray(contents)
      ? contents.map(one).filter(Boolean).join('\n\n')
      : one(contents)
    return text.trim()
  }

  const position = (line: number, character: number) => ({
    line: Math.max(0, line - 1),
    character: Math.max(0, character - 1),
  })

  async function checkPosition(located: Located, line: number, character: number): Promise<void> {
    const doc = located.entry.docs.get(located.uri)
    const lines = (doc?.text ?? '').split(/\r?\n/)
    if (!Number.isInteger(line) || line < 1 || line > lines.length) {
      throw new LspError(`line ${line} is out of range (the file has ${lines.length} lines)`)
    }
    const len = lines[line - 1]?.length ?? 0
    if (!Number.isInteger(character) || character < 1 || character > len + 1) {
      throw new LspError(
        `character ${character} is out of range (line ${line} has ${len} characters)`,
      )
    }
  }

  async function positional(
    method: string,
    path: string,
    line: number,
    character: number,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    const located = await open(path)
    await checkPosition(located, line, character)
    return ask(located, method, {
      textDocument: { uri: located.uri },
      position: position(line, character),
      ...extra,
    })
  }

  async function flattenSymbols(
    raw: unknown,
    depth: number,
    out: LspSymbolItem[],
    withPath: boolean,
  ): Promise<void> {
    if (!Array.isArray(raw)) return
    for (const s of raw as Array<Record<string, unknown>>) {
      const loc = s.location as { uri?: string; range?: LspRange } | undefined
      const range = (s.selectionRange ?? s.range ?? loc?.range) as LspRange | undefined
      const item: LspSymbolItem = {
        name: String(s.name),
        kind: SYMBOL_KINDS[Number(s.kind)] ?? 'Symbol',
        depth,
        line: (range?.start.line ?? 0) + 1,
      }
      if (typeof s.containerName === 'string' && s.containerName) item.container = s.containerName
      if (withPath && loc?.uri) item.path = (await locate(loc.uri, range ?? emptyRange)).path
      out.push(item)
      await flattenSymbols(s.children, depth + 1, out, withPath)
    }
  }
  const emptyRange: LspRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

  return {
    available: entries.length > 0,
    serverFor: (path) => entryFor(path)?.name ?? null,
    async definition(path, line, character) {
      return locations(await positional('textDocument/definition', path, line, character))
    },
    async references(path, line, character) {
      return locations(
        await positional('textDocument/references', path, line, character, {
          context: { includeDeclaration: true },
        }),
      )
    },
    async hover(path, line, character) {
      const raw = (await positional('textDocument/hover', path, line, character)) as {
        contents?: unknown
      } | null
      return raw ? hoverText(raw.contents) : ''
    },
    async diagnostics(path) {
      const located = await open(path, true)
      return diagnosticItems(located.uri, located.client.diagnosticsFor(located.uri))
    },
    async allDiagnostics() {
      const out: LspDiagnosticItem[] = []
      for (const entry of entries) {
        if (!entry.client?.alive) continue
        for (const uri of entry.docs.keys()) {
          out.push(...(await diagnosticItems(uri, entry.client.diagnosticsFor(uri))))
        }
      }
      return out
    },
    async symbols(path) {
      const located = await open(path)
      const raw = await ask(located, 'textDocument/documentSymbol', {
        textDocument: { uri: located.uri },
      })
      const out: LspSymbolItem[] = []
      await flattenSymbols(raw, 0, out, false)
      return out
    },
    async workspaceSymbols(query, path) {
      const entry = path ? entryFor(path) : entries[0]
      if (!entry) {
        throw new LspError(
          path
            ? `no language server configured for "${extname(path) || path}" files`
            : 'no language server is configured',
        )
      }
      const client = await connect(entry)
      let raw: unknown
      try {
        raw = await client.request('workspace/symbol', { query })
      } catch (error) {
        throw new LspError(`language server "${entry.name}": ${messageOf(error)}`)
      }
      const out: LspSymbolItem[] = []
      await flattenSymbols(raw, 0, out, true)
      return out
    },
    status() {
      return entries.map((e) => ({
        name: e.name,
        command: e.command,
        extensions: e.extensions,
        state: e.client?.alive
          ? 'running'
          : e.failure || (e.client && !e.client.alive)
            ? 'failed'
            : 'idle',
        ...(e.failure || (e.client && !e.client.alive)
          ? { detail: e.failure ?? e.client?.deathReason }
          : {}),
      }))
    },
    async close() {
      closed = true
      await Promise.all(
        entries.map(async (e) => {
          const client = e.client ?? (await e.starting?.catch(() => undefined))
          e.docs.clear()
          await client?.stop()
        }),
      )
    },
  }
}
