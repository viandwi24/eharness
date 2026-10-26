/**
 * A script's TypeScript made ready for QuickJS: types stripped with Bun's transpiler, imports
 * refused (a script reaches the system only through `ctx`), a default export required. Syntax
 * errors come back as a sentence with the line, so an agent can fix them.
 */

export type Prepared = { ok: true; js: string } | { ok: false; error: string }

const MAX_SOURCE_CHARS = 200_000

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' })

export function prepareScript(source: string): Prepared {
  if (source.length > MAX_SOURCE_CHARS)
    return {
      ok: false,
      error: `the script is ${source.length} characters; at most ${MAX_SOURCE_CHARS}`,
    }
  let scan: { exports: string[]; imports: Array<{ path: string; kind: string }> }
  let js: string
  try {
    scan = transpiler.scan(source)
    js = transpiler.transformSync(source)
  } catch (error) {
    return { ok: false, error: `the script does not compile: ${syntaxText(error)}` }
  }
  if (scan.imports.length > 0)
    return {
      ok: false,
      error: `scripts cannot import modules (${scan.imports
        .map((i) => i.path)
        .slice(0, 3)
        .join(', ')}): use what ctx offers`,
    }
  // `import()` with a computed path is not in the scan; QuickJS has no module loader either way
  if (/\bimport\s*\(/.test(js))
    return { ok: false, error: 'scripts cannot import modules: use what ctx offers' }
  if (!scan.exports.includes('default'))
    return {
      ok: false,
      error: 'a script needs a default export: export default async function (event, ctx) { ... }',
    }
  return { ok: true, js }
}

interface BuildMessageLike {
  message?: string
  position?: { line?: number; column?: number } | null
}

/** Bun's build error (one `BuildMessage`, or an aggregate of them) as one line with positions. */
function syntaxText(error: unknown): string {
  const one = (e: BuildMessageLike): string => {
    const p = e.position
    const at =
      p?.line === undefined
        ? ''
        : ` (line ${p.line}${p.column === undefined ? '' : `, column ${p.column}`})`
    return `${e.message ?? 'syntax error'}${at}`
  }
  const list = (error as { errors?: BuildMessageLike[] })?.errors
  if (Array.isArray(list) && list.length > 0) return list.slice(0, 3).map(one).join('; ')
  if (typeof error === 'object' && error !== null && 'message' in error)
    return one(error as BuildMessageLike)
  return String(error)
}
