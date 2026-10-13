/**
 * The artifact kind registry (plan P45): the one extension point for what the agent generates for a
 * person to look at. Pure TypeScript with no imports, used by the server (validation, content types,
 * exports) and importable by the web (labels, render mode, editors).
 *
 * Adding a kind: one entry in `ARTIFACT_KINDS` here, a `produceExport` branch on the server if it
 * has server-made exports, and one viewer component on the web. Nothing else.
 */

/** A file of an artifact as validation sees it. `text` is set for text files only. */
export interface ArtifactFileInfo {
  /** Path relative to the artifact folder (`index.html`, `img/logo.png`). */
  path: string
  size: number
  mediaType: string
  text?: string | undefined
}

export interface ArtifactExportDef {
  id: string
  label: string
  mediaType: string
  /** File extension of the download (without the dot); empty = keep the file's own. */
  ext: string
  /** Produced in the browser (print to PDF, rasterise to PNG); the server has no such export. */
  client?: boolean
}

export interface ArtifactKindDef {
  id: string
  label: string
  /** Accepted entry-file extensions (lower case, with the dot). */
  entry: string[]
  /** Entry names tried first, in order, when the entry is not given. */
  defaultEntry: string[]
  mediaTypes: string[]
  /** `frame`: a sandboxed iframe from the content origin. `native`: the web renders it itself. */
  render: 'frame' | 'native'
  /** Structure problems, shown to the agent (empty = fine). */
  validate?: (files: ArtifactFileInfo[], entry: string) => string[]
  exports: ArtifactExportDef[]
  /** Which editor the web offers; absent = none (the agent edits). */
  editable?: 'markdown' | 'text'
}

/** Media types by extension (content routes and file lists). */
export const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.mermaid': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
}

const CODE_EXTENSIONS = [
  '.py',
  '.ts',
  '.tsx',
  '.jsx',
  '.js',
  '.mjs',
  '.sh',
  '.sql',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.c',
  '.h',
  '.cpp',
  '.cs',
  '.swift',
  '.lua',
  '.r',
  '.css',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.txt',
]

/** Lower-case extension with the dot (`''` when none). */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** Media type of a file name (`application/octet-stream` when unknown). */
export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extOf(path)] ?? 'application/octet-stream'
}

/** The media type without parameters (`text/html`). */
export const baseMediaType = (mediaType: string): string => mediaType.split(';')[0]?.trim() ?? ''

const isRelativeRef = (ref: string): boolean =>
  ref !== '' &&
  !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref) &&
  !ref.startsWith('{') &&
  !ref.includes('${')

const normalizeRel = (from: string, ref: string): string => {
  const clean = ref.split(/[?#]/)[0] ?? ''
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
  const parts: string[] = []
  for (const seg of `${base}${decodeURI(clean)}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** Hosts a page may load scripts, styles, fonts and images from (the content CSP allowlist). */
export const CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
] as const

function validateHtml(files: ArtifactFileInfo[], entry: string): string[] {
  const problems: string[] = []
  const main = files.find((f) => f.path === entry)
  if (main === undefined) return [`The entry file ${entry} does not exist.`]
  const html = main.text ?? ''
  if (html.trim() === '') return [`${entry} is empty.`]
  if (!/<(html|body|head|!doctype|script|div|main|section|canvas|svg)\b/i.test(html)) {
    problems.push(`${entry} does not look like an HTML page (no <html>, <body> or elements).`)
  }
  const known = new Set(files.map((f) => f.path))
  const missing = new Set<string>()
  const external = new Set<string>()
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = (m[1] ?? '').trim()
    if (isRelativeRef(ref)) {
      const target = normalizeRel(entry, ref)
      if (target !== '' && !known.has(target)) missing.add(ref)
      continue
    }
    const host = /^(?:https?:)?\/\/([^/:?#]+)/i.exec(ref)?.[1]?.toLowerCase()
    if (host !== undefined && !(CDN_HOSTS as readonly string[]).includes(host)) {
      // links (<a href>) to other sites are fine; blocked loads are scripts, styles, images
      const tag = html.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0)
      if (/<(script|link|img|source|iframe|video|audio)\b[^>]*$/i.test(tag)) external.add(host)
    }
  }
  if (missing.size > 0) {
    problems.push(`${entry} references files that are not in the artifact: ${[...missing].slice(0, 8).join(', ')}.`)
  }
  if (external.size > 0) {
    problems.push(
      `${entry} loads from hosts the page may not reach (${[...external].slice(0, 6).join(', ')}). Pages may load scripts, styles, fonts and images only from ${CDN_HOSTS.join(', ')} or from files in the artifact; there is no other network.`,
    )
  }
  if (/\bfetch\s*\(\s*["'`](https?:|\/api)/i.test(html)) {
    problems.push(
      `${entry} calls fetch() on a network URL; the page has no network access (connect-src is none). Embed the data in the page or ship it as a file of the artifact.`,
    )
  }
  return problems
}

function validateDocument(files: ArtifactFileInfo[], entry: string): string[] {
  const main = files.find((f) => f.path === entry)
  if (main === undefined) return [`The entry file ${entry} does not exist.`]
  if ((main.text ?? '').trim() === '') return [`${entry} is empty.`]
  return []
}

function validateImage(files: ArtifactFileInfo[], entry: string): string[] {
  const main = files.find((f) => f.path === entry)
  if (main === undefined) return [`The entry file ${entry} does not exist.`]
  if (main.size === 0) return [`${entry} is empty.`]
  if (extOf(entry) === '.svg') {
    const text = main.text ?? ''
    if (!/<svg\b/i.test(text)) return [`${entry} is not an SVG (no <svg> element).`]
    if (!/\bxmlns\s*=/.test(text)) {
      return [`${entry}: the <svg> element needs xmlns="http://www.w3.org/2000/svg" to render on its own.`]
    }
  }
  return []
}

const MERMAID_TYPES =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey(-beta)?|xychart(-beta)?|block(-beta)?|packet(-beta)?|kanban|architecture(-beta)?|radar(-beta)?|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|treemap(-beta)?)\b/

function validateMermaid(files: ArtifactFileInfo[], entry: string): string[] {
  const main = files.find((f) => f.path === entry)
  if (main === undefined) return [`The entry file ${entry} does not exist.`]
  const text = (main.text ?? '')
    .replace(/^\s*---[\s\S]*?---\s*/, '')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('%%'))
  if (text.length === 0) return [`${entry} is empty.`]
  if (!MERMAID_TYPES.test((text[0] ?? '').trim())) {
    return [
      `${entry} must start with a Mermaid diagram type (flowchart, sequenceDiagram, gantt, pie, xychart-beta, ...); the first line is "${(text[0] ?? '').trim().slice(0, 40)}".`,
    ]
  }
  return []
}

function validateCode(files: ArtifactFileInfo[], entry: string): string[] {
  const main = files.find((f) => f.path === entry)
  if (main === undefined) return [`The entry file ${entry} does not exist.`]
  return (main.text ?? '').trim() === '' ? [`${entry} is empty.`] : []
}

/** Splits one CSV line (quotes, doubled quotes); good enough to count columns. */
function csvColumns(line: string): number {
  let n = 1
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (quoted && line[i + 1] === '"') i++
      else quoted = !quoted
    } else if (c === ',' && !quoted) n++
  }
  return n
}

function validateData(files: ArtifactFileInfo[], entry: string): string[] {
  const main = files.find((f) => f.path === entry)
  if (main === undefined) return [`The entry file ${entry} does not exist.`]
  const text = main.text ?? ''
  if (text.trim() === '') return [`${entry} is empty.`]
  if (extOf(entry) === '.json') {
    try {
      JSON.parse(text)
    } catch (error) {
      return [`${entry} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]
    }
    return []
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const head = csvColumns(lines[0] ?? '')
  const bad = lines.findIndex((l, i) => i > 0 && csvColumns(l) !== head && !l.includes('"'))
  return bad < 0 ? [] : [`${entry} line ${bad + 1} has a different number of columns than the header (${head}).`]
}

export const ARTIFACT_KINDS: ArtifactKindDef[] = [
  {
    id: 'html',
    label: 'HTML page',
    entry: ['.html', '.htm'],
    defaultEntry: ['index.html'],
    mediaTypes: ['text/html'],
    render: 'frame',
    validate: validateHtml,
    exports: [
      { id: 'html', label: 'HTML', mediaType: 'text/html; charset=utf-8', ext: 'html' },
      { id: 'zip', label: 'ZIP', mediaType: 'application/zip', ext: 'zip' },
    ],
  },
  {
    id: 'document',
    label: 'Document',
    entry: ['.md', '.markdown'],
    defaultEntry: ['document.md', 'README.md', 'index.md'],
    mediaTypes: ['text/markdown'],
    render: 'native',
    validate: validateDocument,
    exports: [
      { id: 'md', label: 'Markdown', mediaType: 'text/markdown; charset=utf-8', ext: 'md' },
      { id: 'html', label: 'HTML', mediaType: 'text/html; charset=utf-8', ext: 'html' },
      { id: 'pdf', label: 'PDF', mediaType: 'application/pdf', ext: 'pdf', client: true },
    ],
    editable: 'markdown',
  },
  {
    id: 'image',
    label: 'Image',
    entry: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'],
    defaultEntry: ['image.png', 'chart.png', 'image.svg', 'chart.svg'],
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'],
    // SVG always goes through the frame; the web decides per entry extension
    render: 'native',
    validate: validateImage,
    exports: [
      { id: 'original', label: 'Original', mediaType: '', ext: '' },
      { id: 'png', label: 'PNG', mediaType: 'image/png', ext: 'png', client: true },
    ],
  },
  {
    id: 'mermaid',
    label: 'Diagram',
    entry: ['.mmd', '.mermaid'],
    defaultEntry: ['diagram.mmd'],
    mediaTypes: ['text/plain'],
    render: 'native',
    validate: validateMermaid,
    exports: [
      { id: 'mmd', label: 'Mermaid source', mediaType: 'text/plain; charset=utf-8', ext: 'mmd' },
      { id: 'svg', label: 'SVG', mediaType: 'image/svg+xml', ext: 'svg', client: true },
      { id: 'png', label: 'PNG', mediaType: 'image/png', ext: 'png', client: true },
    ],
    editable: 'text',
  },
  {
    id: 'code',
    label: 'Code',
    entry: CODE_EXTENSIONS,
    defaultEntry: [],
    mediaTypes: ['text/plain'],
    render: 'native',
    validate: validateCode,
    exports: [{ id: 'original', label: 'Original', mediaType: '', ext: '' }],
    editable: 'text',
  },
  {
    id: 'data',
    label: 'Data',
    entry: ['.csv', '.tsv', '.json'],
    defaultEntry: ['data.csv', 'data.json'],
    mediaTypes: ['text/csv', 'application/json'],
    render: 'native',
    validate: validateData,
    exports: [
      { id: 'csv', label: 'CSV', mediaType: 'text/csv; charset=utf-8', ext: 'csv' },
      { id: 'json', label: 'JSON', mediaType: 'application/json; charset=utf-8', ext: 'json' },
    ],
  },
  {
    // fallback: anything (metadata and a download)
    id: 'file',
    label: 'File',
    entry: [],
    defaultEntry: [],
    mediaTypes: ['*/*'],
    render: 'native',
    exports: [{ id: 'original', label: 'Original', mediaType: '', ext: '' }],
  },
]

export const ARTIFACT_KIND_IDS: string[] = ARTIFACT_KINDS.map((k) => k.id)

/** The kind of an id; an unknown id falls back to `file`. */
export function kindOf(id: string): ArtifactKindDef {
  return (
    ARTIFACT_KINDS.find((k) => k.id === id) ??
    (ARTIFACT_KINDS[ARTIFACT_KINDS.length - 1] as ArtifactKindDef)
  )
}

export const isKnownKind = (id: string): boolean => ARTIFACT_KINDS.some((k) => k.id === id)

/**
 * The entry file of an artifact: the given one, else a default name that exists, else the first file
 * with an accepted extension (the shortest path first), else the first file. Undefined = no files.
 */
export function pickEntry(kindId: string, paths: string[], wanted?: string): string | undefined {
  if (wanted !== undefined && wanted !== '') return paths.includes(wanted) ? wanted : undefined
  const kind = kindOf(kindId)
  for (const name of kind.defaultEntry) if (paths.includes(name)) return name
  const sorted = [...paths].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
  return sorted.find((p) => kind.entry.includes(extOf(p))) ?? sorted[0]
}

/** Structure problems of an artifact (the kind's `validate`), plus the entry's own extension. */
export function validateArtifact(kindId: string, files: ArtifactFileInfo[], entry: string): string[] {
  const kind = kindOf(kindId)
  const problems: string[] = []
  if (files.length === 0) return ['The artifact has no files.']
  if (kind.entry.length > 0 && !kind.entry.includes(extOf(entry))) {
    problems.push(
      `The entry ${entry} is not a ${kind.label.toLowerCase()} file; expected ${kind.entry.join(', ')}.`,
    )
  }
  return [...problems, ...(kind.validate?.(files, entry) ?? [])]
}

/** Guess a kind from an entry file name (for adopting files without a stated kind). */
export function kindForFile(path: string): string {
  const ext = extOf(path)
  for (const id of ['html', 'document', 'image', 'mermaid', 'data']) {
    if (kindOf(id).entry.includes(ext)) return id
  }
  return CODE_EXTENSIONS.includes(ext) ? 'code' : 'file'
}
