/**
 * Check a script without running it (P59): TypeScript errors against the generated `scripts.d.ts`,
 * a few lint rules for what goes wrong in scripts, and `ctx` calls the manifest does not grant.
 * The compiler (TypeScript 5, under the `typescript5` alias) loads on the first check; its standard
 * library files are parsed once and reused.
 */
import type * as TS from 'typescript5'
import type { ScriptManifest } from '../../domain/script-manifest.ts'

export interface CheckProblem {
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
  /** `ts1234` for compiler messages, a rule name for the rest. */
  code: string
}

export interface CheckResult {
  ok: boolean
  errors: number
  warnings: number
  problems: CheckProblem[]
  durationMs: number
}

const SCRIPT = '/script.ts'
const TYPES = '/scripts.d.ts'
/** Unused names are warnings, not errors. */
const WARNING_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7027, 7028])
/** Globals a script does not have (the sandbox has no timers, network or Node). */
const MISSING_GLOBALS = [
  'fetch',
  'setTimeout',
  'setInterval',
  'require',
  'process',
  'Bun',
  'XMLHttpRequest',
  'WebSocket',
]

let tsPromise: Promise<typeof TS> | null = null
const loadTs = (): Promise<typeof TS> => {
  tsPromise ??= import('typescript5').then(
    (m) => (m as { default?: typeof TS }).default ?? (m as unknown as typeof TS),
  )
  return tsPromise
}
const libCache = new Map<string, TS.SourceFile>()

/** Which grant a `ctx` method needs, and whether it is there. */
function grantProblem(method: string, m: ScriptManifest): string | undefined {
  const g = m.grants
  const has = (x: readonly unknown[]): boolean => x.length > 0
  switch (method) {
    case 'channels.send':
    case 'channels.edit':
    case 'channels.delete':
    case 'channels.pin':
    case 'channels.react':
      return has(g.send) ? undefined : 'grants.send is empty'
    case 'channels.reply':
      return g.reply ? undefined : 'grants.reply is off'
    case 'channels.history':
    case 'channels.message':
    case 'channels.members':
    case 'channels.download':
    case 'channels.chats':
      return has(g.read) || has(g.send) ? undefined : 'grants.read and grants.send are empty'
    case 'channels.action':
      return has(g.actions) ? undefined : 'grants.actions is empty'
    case 'library.read':
    case 'library.list':
      return has(g.libraryRead) || has(g.libraryWrite) ? undefined : 'grants.libraryRead is empty'
    case 'library.write':
    case 'library.delete':
    case 'library.move':
      return has(g.libraryWrite) ? undefined : 'grants.libraryWrite is empty'
    case 'tables.query':
    case 'tables.get':
    case 'tables.aggregate':
      return has(g.tablesRead) || has(g.tablesWrite) ? undefined : 'grants.tablesRead is empty'
    case 'tables.insert':
    case 'tables.update':
    case 'tables.delete':
      return has(g.tablesWrite) ? undefined : 'grants.tablesWrite is empty'
    case 'http.get':
    case 'http.request':
      return has(g.http) ? undefined : 'grants.http is empty'
    case 'agent.wake':
      return has(g.wake) ? undefined : 'grants.wake is empty'
    case 'programs.list':
    case 'programs.run':
      return has(g.programs) ? undefined : 'grants.programs is empty'
    case 'api.get':
    case 'api.request':
      return has(g.api) ? undefined : 'grants.api is empty'
    case 'notify':
      return g.notify ? undefined : 'grants.notify is off'
    default:
      return undefined
  }
}

/** A string literal property of an object literal argument (`{ table: 'x' }` → 'x'). */
function literalProp(ts: typeof TS, call: TS.CallExpression, name: string): string | undefined {
  const arg = call.arguments[0]
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined
  for (const p of arg.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      p.name.getText() === name &&
      ts.isStringLiteralLike(p.initializer)
    )
      return p.initializer.text
  }
  return undefined
}

export async function checkScript(input: {
  source: string
  types: string
  manifest: ScriptManifest
}): Promise<CheckResult> {
  const started = performance.now()
  const ts = await loadTs()
  const options: TS.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.es2022.d.ts'],
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    noUnusedLocals: true,
    noUnusedParameters: false,
    skipLibCheck: true,
    types: [],
  }
  const libFile = ts.getDefaultLibFilePath(options)
  const libDir = libFile.slice(0, libFile.lastIndexOf('/'))
  const files = new Map<string, string>([
    [SCRIPT, input.source],
    [TYPES, input.types],
  ])
  const host: TS.CompilerHost = {
    getSourceFile(fileName, languageVersion) {
      const own = files.get(fileName)
      if (own !== undefined) return ts.createSourceFile(fileName, own, languageVersion, true)
      const cached = libCache.get(fileName)
      if (cached !== undefined) return cached
      const text = ts.sys.readFile(fileName)
      if (text === undefined) return undefined
      const sf = ts.createSourceFile(fileName, text, languageVersion, true)
      libCache.set(fileName, sf)
      return sf
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    getDefaultLibLocation: () => libDir,
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
    readFile: (f) => files.get(f) ?? ts.sys.readFile(f),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const program = ts.createProgram([TYPES, SCRIPT], options, host)
  const sf = program.getSourceFile(SCRIPT)
  const problems: CheckProblem[] = []
  const at = (node: TS.Node | number): { line: number; column: number } => {
    const pos = typeof node === 'number' ? node : node.getStart()
    const lc = sf ? sf.getLineAndCharacterOfPosition(pos) : { line: 0, character: 0 }
    return { line: lc.line + 1, column: lc.character + 1 }
  }

  const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
  for (const d of diags) {
    if (d.file?.fileName !== SCRIPT) continue
    const warning = WARNING_CODES.has(d.code)
    problems.push({
      ...at(d.start ?? 0),
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      severity: warning ? 'warning' : 'error',
      code: `ts${d.code}`,
    })
  }

  if (sf !== undefined) {
    let hasDefault = false
    const visit = (node: TS.Node): void => {
      if (ts.isExportAssignment(node)) hasDefault = true
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      )
        hasDefault = true
      if (
        ts.isImportDeclaration(node) ||
        (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      )
        problems.push({
          ...at(node),
          message: 'Imports are not available in scripts: everything goes through ctx.',
          severity: 'error',
          code: 'no-import',
        })
      if (ts.isIdentifier(node) && MISSING_GLOBALS.includes(node.text)) {
        const parent = node.parent
        const isName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent)
        if (!isName)
          problems.push({
            ...at(node),
            message: `${node.text} does not exist in scripts${node.text === 'fetch' ? ': use ctx.http.get / ctx.http.request' : node.text.startsWith('set') ? ': use await ctx.sleep(ms)' : ''}.`,
            severity: 'error',
            code: 'no-global',
          })
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        // ctx.<area>.<method>(…) or ctx.<method>(…)
        const parts: string[] = []
        let e: TS.Expression = node.expression
        while (ts.isPropertyAccessExpression(e)) {
          parts.unshift(e.name.text)
          e = e.expression
        }
        if (ts.isIdentifier(e) && e.text === 'ctx' && parts.length > 0) {
          const method = parts.join('.')
          const missing = grantProblem(method, input.manifest)
          if (missing !== undefined)
            problems.push({
              ...at(node),
              message: `ctx.${method} will be refused: ${missing} in the manifest.`,
              severity: 'warning',
              code: 'grant',
            })
          const table = method.startsWith('tables.') ? literalProp(ts, node, 'table') : undefined
          if (table !== undefined) {
            const write = ['tables.insert', 'tables.update', 'tables.delete'].includes(method)
            const list = write
              ? input.manifest.grants.tablesWrite
              : [...input.manifest.grants.tablesRead, ...input.manifest.grants.tablesWrite]
            if (!list.includes('*') && !list.includes(table))
              problems.push({
                ...at(node),
                message: `Table ${table} is not in grants.${write ? 'tablesWrite' : 'tablesRead'}.`,
                severity: 'warning',
                code: 'grant',
              })
          }
          const chat = [
            'channels.send',
            'channels.edit',
            'channels.delete',
            'channels.pin',
            'channels.react',
          ].includes(method)
            ? literalProp(ts, node, 'chat')
            : undefined
          if (
            chat !== undefined &&
            !input.manifest.grants.send.some(
              (x) => x.chat === '*' || x.chat.toLowerCase() === chat.toLowerCase(),
            )
          )
            problems.push({
              ...at(node),
              message: `Chat "${chat}" is not in grants.send.`,
              severity: 'warning',
              code: 'grant',
            })
          // a ctx call nobody waits for: its error is lost and the run may end before it finishes
          const p = node.parent
          const awaited =
            ts.isAwaitExpression(p) ||
            ts.isReturnStatement(p) ||
            ts.isVariableDeclaration(p) ||
            ts.isPropertyAccessExpression(p) ||
            ts.isCallExpression(p) ||
            ts.isArrayLiteralExpression(p) ||
            ts.isArrowFunction(p) ||
            ts.isBinaryExpression(p) ||
            ts.isPropertyAssignment(p)
          if (!awaited && method !== 'log')
            problems.push({
              ...at(node),
              message: `ctx.${method}(…) is not awaited: write await, or its result and errors are lost.`,
              severity: 'warning',
              code: 'no-floating',
            })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (!hasDefault)
      problems.push({
        line: 1,
        column: 1,
        message: 'The script needs `export default async function (event, ctx) { … }`.',
        severity: 'error',
        code: 'default-export',
      })
  }

  problems.sort((a, b) => a.line - b.line || a.column - b.column)
  const errors = problems.filter((p) => p.severity === 'error').length
  return {
    ok: errors === 0,
    errors,
    warnings: problems.length - errors,
    problems: problems.slice(0, 100),
    durationMs: Math.round(performance.now() - started),
  }
}
