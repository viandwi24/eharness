/**
 * Accessibility snapshot with element refs (spec 35 §4.1): the AX tree rendered as an indented
 * outline, refs `e<n>` mapped to `(snapshotId, frameId, backendDOMNodeId)`, loader-id staleness,
 * a pass for clickable elements without a role, scope, and a size cap with offset and kept tail.
 */
import { call, errorText, frameLoaders, pageInfo } from './page.ts'
import type { PageSession, RefEntry, Snapshot } from './types.ts'

interface AXValue {
  type?: string
  value?: unknown
}
/** The slice of a `Accessibility.AXNode` this module reads. */
export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: Array<{ name: string; value: AXValue }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
])
/** Extra roles that get refs when `interactive` is false. */
const STRUCTURE_REFS = new Set([
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'listitem',
  'row',
  'img',
])
/** Roles drawn without a line of their own: their children are listed in their place. */
const TRANSPARENT = new Set([
  'generic',
  'none',
  'presentation',
  'paragraph',
  'rootwebarea',
  'inlinetextbox',
  'linebreak',
  'section',
])
const NAME_MAX = 200
const TAIL_CHARS = 2_000
const CLICKABLE_MAX = 40

/**
 * A constant script: elements that look clickable (pointer cursor on the outermost element, or an
 * `onclick` attribute) but have no interactive tag or role. Returns an array of elements.
 */
export const CLICKABLE_SCRIPT: string = `(() => {
  const out = [];
  const interactive = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[role=switch],[role=option],[role=combobox],[role=textbox]';
  for (const el of document.querySelectorAll('body *')) {
    if (out.length >= ${CLICKABLE_MAX}) break;
    if (el.closest(interactive)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const handler = el.hasAttribute('onclick');
    const pointer = cs.cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
    if (handler || pointer) out.push(el);
  }
  return out;
})()`

const CLICKABLE_TEXTS = `function () {
  return this.map((e) => (e.getAttribute('aria-label') || e.innerText || e.title || e.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 80));
}`

const str = (v: AXValue | undefined): string => {
  const x = v?.value
  return typeof x === 'string' ? x : typeof x === 'number' ? String(x) : ''
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const cut = flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX)}…` : flat
  return cut.replace(/"/g, '\\"')
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value
}

/** The attribute flags drawn after the name, in a fixed order. */
function flags(node: AXNode): string {
  const out: string[] = []
  const value = str(node.value)
  if (value !== '') out.push(`value="${clip(value)}"`)
  const checked = prop(node, 'checked')
  if (checked === 'true' || checked === true) out.push('[checked]')
  else if (checked === 'mixed') out.push('[checked=mixed]')
  const expanded = prop(node, 'expanded')
  if (expanded === true || expanded === 'true') out.push('[expanded]')
  else if (expanded === false || expanded === 'false') out.push('[collapsed]')
  if (prop(node, 'selected') === true) out.push('[selected]')
  if (prop(node, 'disabled') === true) out.push('[disabled]')
  const level = prop(node, 'level')
  if (typeof level === 'number') out.push(`[level=${level}]`)
  return out.join(' ')
}

/** Does this role get a ref (spec 35 §4.1)? */
export function wantsRef(role: string, interactive: boolean): boolean {
  const r = role.toLowerCase()
  if (INTERACTIVE.has(r) || r.startsWith('menuitem')) return true
  return !interactive && STRUCTURE_REFS.has(r)
}

interface FrameTree {
  byId: Map<string, AXNode>
  roots: AXNode[]
}

function buildTree(nodes: AXNode[]): FrameTree {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId))
  return { byId, roots }
}

/**
 * Cut `text` to `limit` characters from `offset`: a head ending at a line break, a truncation
 * footer with the next offset, and the last {@link TAIL_CHARS} characters of the whole text
 * (pagination and footer links survive).
 */
export function capOutline(
  text: string,
  offset: number,
  limit: number,
  tool = 'browser_snapshot',
): { text: string; nextOffset?: number } {
  if (offset >= text.length && text.length > 0) {
    return { text: `(nothing at offset ${offset}: the snapshot has ${text.length} characters)` }
  }
  const rest = text.slice(offset)
  if (rest.length <= limit) return { text: rest }
  const tailLen = Math.min(TAIL_CHARS, Math.floor(limit / 4))
  const footerFor = (n: number): string => `\n… truncated; call ${tool} with offset ${n} for more\n`
  let headLen = Math.max(0, limit - tailLen - footerFor(offset + limit).length)
  const lineEnd = rest.lastIndexOf('\n', headLen)
  if (lineEnd > 0) headLen = lineEnd
  const nextOffset = offset + headLen
  const tailStart = Math.max(nextOffset, text.length - tailLen)
  return {
    text: rest.slice(0, headLen) + footerFor(nextOffset) + text.slice(tailStart),
    nextOffset,
  }
}

/**
 * Resolve a ref to its entry, or answer why not: an unknown ref, a ref from an older document
 * (`STALE:`), or a ref inside a cross-site iframe (not supported yet).
 */
export async function resolveRef(
  page: PageSession,
  ref: string,
  signal?: AbortSignal,
): Promise<RefEntry | string> {
  if (!/^e\d+$/.test(ref)) {
    return `ERROR: "${ref.slice(0, 40)}" is not a ref. Refs look like e5 and come from browser_snapshot.`
  }
  const entry = page.refs.entries.get(ref)
  if (!entry) {
    return page.refs.lastSnapshotId
      ? `STALE: the page changed since snapshot ${page.refs.lastSnapshotId}. Take a new snapshot.`
      : `ERROR: unknown ref "${ref}". Take a snapshot first with browser_snapshot.`
  }
  if (entry.unsupported) {
    return `ERROR: ${ref} is inside a cross-site iframe (${entry.unsupported}), which is not supported yet. Ask a person with browser_request_human, or open the iframe's address as a page.`
  }
  const frames = await frameLoaders(page, signal)
  if (frames.get(entry.frameId)?.loaderId !== entry.loaderId) {
    return `STALE: the page changed since snapshot ${entry.snapshotId}. Take a new snapshot.`
  }
  return entry
}

/**
 * Take a snapshot of the page (or of the subtree `scope`).
 *
 * @returns the snapshot, or an `ERROR:` / `STALE:` string.
 */
export async function takeSnapshot(
  page: PageSession,
  input: { scope?: string; interactive?: boolean; offset?: number },
  signal?: AbortSignal,
): Promise<Snapshot | string> {
  const interactive = input.interactive ?? true
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  try {
    let scopeEntry: RefEntry | undefined
    if (input.scope) {
      const r = await resolveRef(page, input.scope, signal)
      if (typeof r === 'string') return r
      scopeEntry = r
    }
    const frames = await frameLoaders(page, signal)
    const mainId = [...frames].find(([, f]) => !f.parentId)?.[0]
    if (mainId === undefined) return 'ERROR: the page has no document yet. Open a URL first.'
    const snapshotId = page.refs.nextSnapshotId()
    const trees = new Map<string, FrameTree | null>()
    const listed = new Set<number>()
    const lines: string[] = []
    let refCount = 0

    const loadTree = async (frameId: string): Promise<FrameTree | null> => {
      if (trees.has(frameId)) return trees.get(frameId) ?? null
      let tree: FrameTree | null = null
      try {
        const res = await call<{ nodes?: AXNode[] }>(
          page,
          'Accessibility.getFullAXTree',
          frameId === mainId ? {} : { frameId },
          signal,
        )
        tree = buildTree(res.nodes ?? [])
      } catch (error) {
        if (signal?.aborted) throw error
      }
      trees.set(frameId, tree)
      return tree
    }

    const issue = (
      frameId: string,
      backendNodeId: number,
      role: string,
      name: string,
      unsupported?: string,
    ): string => {
      const loaderId = frames.get(frameId)?.loaderId ?? ''
      const ref = page.refs.refFor(frameId, loaderId, backendNodeId)
      const entry: RefEntry = { ref, snapshotId, frameId, loaderId, backendNodeId, role, name }
      if (unsupported) entry.unsupported = unsupported
      page.refs.entries.set(ref, entry)
      listed.add(backendNodeId)
      refCount++
      return ref
    }

    const render = async (
      frameId: string,
      tree: FrameTree,
      node: AXNode,
      depth: number,
    ): Promise<void> => {
      const role = str(node.role)
      const lower = role.toLowerCase()
      const name = str(node.name)
      const children = async (d: number): Promise<void> => {
        for (const id of node.childIds ?? []) {
          const child = tree.byId.get(id)
          if (child) await render(frameId, tree, child, d)
        }
      }
      if (node.ignored || lower === 'inlinetextbox' || lower === 'linebreak') {
        await children(depth)
        return
      }
      if (lower === 'statictext') {
        const text = name.replace(/\s+/g, ' ').trim()
        const parent = node.parentId ? tree.byId.get(node.parentId) : undefined
        const parentName = parent ? str(parent.name) : ''
        if (text !== '' && !(parentName !== '' && parentName.includes(text))) {
          lines.push(`${'  '.repeat(depth)}- text "${clip(text)}"`)
        }
        return
      }
      if (lower.startsWith('iframe')) {
        const childFrame =
          node.backendDOMNodeId === undefined
            ? undefined
            : await describeFrame(page, node.backendDOMNodeId, signal)
        const pad = '  '.repeat(depth)
        if (childFrame && page.oopifs.has(childFrame)) {
          const ref =
            node.backendDOMNodeId === undefined
              ? ''
              : ` [ref=${issue(frameId, node.backendDOMNodeId, 'iframe', name, 'cross-site iframe')}]`
          lines.push(
            `${pad}- iframe${name ? ` "${clip(name)}"` : ''} [cross-site, not supported yet]${ref}`,
          )
          return
        }
        lines.push(`${pad}- iframe${name ? ` "${clip(name)}"` : ''}`)
        const sub = childFrame && frames.has(childFrame) ? await loadTree(childFrame) : null
        if (sub && childFrame)
          for (const r of sub.roots) await render(childFrame, sub, r, depth + 1)
        return
      }
      const transparent = TRANSPARENT.has(lower) && (name === '' || lower === 'rootwebarea')
      if (transparent) {
        await children(depth)
        return
      }
      const parts = [`- ${lower === 'rootwebarea' ? 'document' : lower}`]
      if (name !== '') parts.push(`"${clip(name)}"`)
      const f = flags(node)
      if (f !== '') parts.push(f)
      if (node.backendDOMNodeId !== undefined && wantsRef(role, interactive)) {
        parts.push(`[ref=${issue(frameId, node.backendDOMNodeId, lower, name)}]`)
      }
      lines.push('  '.repeat(depth) + parts.join(' '))
      await children(depth + 1)
    }

    if (scopeEntry) {
      const tree = await loadTree(scopeEntry.frameId)
      const node = tree
        ? [...tree.byId.values()].find((n) => n.backendDOMNodeId === scopeEntry.backendNodeId)
        : undefined
      if (!tree || !node) {
        return `STALE: ${scopeEntry.ref} is no longer on the page (snapshot ${scopeEntry.snapshotId}). Take a new snapshot.`
      }
      await render(scopeEntry.frameId, tree, node, 0)
    } else {
      const tree = await loadTree(mainId)
      if (!tree) return 'ERROR: the browser could not read the accessibility tree of this page.'
      for (const root of tree.roots) await render(mainId, tree, root, 0)
      if (lines.length === 0) lines.push('(the page has no accessible content yet)')
      lines.push(...(await clickablePass(page, mainId, listed, issue, signal)))
    }

    const capped = capOutline(lines.join('\n'), offset, page.limits.snapshotChars)
    return {
      id: snapshotId,
      text: capped.text,
      page: await pageInfo(page, signal),
      ...(capped.nextOffset !== undefined ? { nextOffset: capped.nextOffset } : {}),
      refCount,
    }
  } catch (error) {
    if (signal?.aborted) return 'ERROR: aborted.'
    return `ERROR: ${errorText(error)}`
  }
}

/** The child frame id of an iframe element (`DOM.describeNode` of a frame owner). */
async function describeFrame(
  page: PageSession,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await call<{ node?: { frameId?: string; contentDocument?: { frameId?: string } } }>(
      page,
      'DOM.describeNode',
      { backendNodeId },
      signal,
    )
    return res.node?.contentDocument?.frameId ?? res.node?.frameId
  } catch {
    return undefined
  }
}

/** Elements with a pointer cursor or click handler but no role: `- clickable "text" [ref=e9]`. */
async function clickablePass(
  page: PageSession,
  frameId: string,
  listed: Set<number>,
  issue: (frameId: string, backendNodeId: number, role: string, name: string) => string,
  signal?: AbortSignal,
): Promise<string[]> {
  const out: string[] = []
  try {
    const ev = await call<{ result?: { objectId?: string } }>(
      page,
      'Runtime.evaluate',
      { expression: CLICKABLE_SCRIPT, returnByValue: false, objectGroup: 'eh-snapshot' },
      signal,
    )
    const arrayId = ev.result?.objectId
    if (!arrayId) return out
    const props = await call<{
      result?: Array<{ name: string; value?: { objectId?: string } }>
    }>(page, 'Runtime.getProperties', { objectId: arrayId, ownProperties: true }, signal)
    const texts = await call<{ result?: { value?: string[] } }>(
      page,
      'Runtime.callFunctionOn',
      {
        objectId: arrayId,
        functionDeclaration: CLICKABLE_TEXTS,
        returnByValue: true,
      },
      signal,
    )
    const names = texts.result?.value ?? []
    for (const p of props.result ?? []) {
      if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue
      const described = await call<{ node?: { backendNodeId?: number } }>(
        page,
        'DOM.describeNode',
        { objectId: p.value.objectId },
        signal,
      )
      const backendId = described.node?.backendNodeId
      if (backendId === undefined || listed.has(backendId)) continue
      const name = names[Number(p.name)] ?? ''
      const ref = issue(frameId, backendId, 'clickable', name)
      out.push(`- clickable${name ? ` "${clip(name)}"` : ''} [ref=${ref}]`)
    }
    await call(page, 'Runtime.releaseObjectGroup', { objectGroup: 'eh-snapshot' }, signal).catch(
      () => {},
    )
  } catch (error) {
    if (signal?.aborted) throw error
  }
  return out
}
