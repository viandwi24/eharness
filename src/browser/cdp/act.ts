/**
 * Acting on a page like a person, failing like a tool (spec 35 §4.2): scroll into view, box centre
 * with the frame offset, a hit test (a covering element answers `BLOCKED:`), mouse moved → pressed →
 * released, `el.click()` when the box is empty, fill/type/press/select/check/uncheck/scroll/wait,
 * and a settle (network idle or `limits.settleMs`) afterwards. Expected failures are strings.
 */
import { keyEvents, parseKeyCombo } from './keys.ts'
import {
  call,
  callOn,
  errorText,
  evaluate,
  fingerprint,
  frameLoaders,
  mainFrame,
  objectIdOf,
  pageInfo,
  settle,
  sleep,
} from './page.ts'
import { resolveRef } from './snapshot.ts'
import type { ActInput, ActResult, PageSession, RefEntry } from './types.ts'

/** Outcome of one action before the settle. */
interface Outcome {
  summary: string
  error?: string
  note?: string
}

const failed = (error: string): Outcome => ({ summary: error, error })

const MAX_WAIT_MS = 10_000

function describe(entry: RefEntry): string {
  return `${entry.role}${entry.name ? ` "${entry.name.slice(0, 60)}"` : ''}`
}

interface Located {
  entry: RefEntry
  objectId: string
}

async function locate(
  page: PageSession,
  ref: string,
  signal?: AbortSignal,
): Promise<Located | string> {
  const entry = await resolveRef(page, ref, signal)
  if (typeof entry === 'string') return entry
  let objectId: string | undefined
  try {
    objectId = await objectIdOf(page, entry.backendNodeId, signal)
  } catch (error) {
    if (signal?.aborted) throw error
  }
  if (!objectId) {
    return `STALE: ${ref} is no longer on the page (snapshot ${entry.snapshotId}). Take a new snapshot.`
  }
  return { entry, objectId }
}

type Quad = number[]

function quadBox(
  quad: Quad | undefined,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!quad || quad.length < 8) return undefined
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[]
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** Offset of a frame's viewport inside the top-level viewport (sum of the iframe elements' boxes). */
async function frameOffset(
  page: PageSession,
  frameId: string,
  signal?: AbortSignal,
): Promise<{ x: number; y: number }> {
  const frames = await frameLoaders(page, signal)
  let x = 0
  let y = 0
  let id: string | undefined = frameId
  for (let depth = 0; id && depth < 8; depth++) {
    const f = frames.get(id)
    if (!f?.parentId) break
    try {
      const owner = await call<{ backendNodeId?: number }>(
        page,
        'DOM.getFrameOwner',
        { frameId: id },
        signal,
      )
      if (owner.backendNodeId === undefined) break
      const box = await call<{ model?: { content?: Quad } }>(
        page,
        'DOM.getBoxModel',
        { backendNodeId: owner.backendNodeId },
        signal,
      )
      const b = quadBox(box.model?.content)
      if (b) {
        x += b.x
        y += b.y
      }
    } catch {
      break
    }
    id = f.parentId
  }
  return { x, y }
}

/** Scroll into view and return the centre of the element in top-level viewport pixels. */
async function pointOf(
  page: PageSession,
  entry: RefEntry,
  signal?: AbortSignal,
): Promise<{ x: number; y: number } | undefined> {
  try {
    await call(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, signal)
  } catch {}
  try {
    const res = await call<{ model?: { content?: Quad; border?: Quad } }>(
      page,
      'DOM.getBoxModel',
      { backendNodeId: entry.backendNodeId },
      signal,
    )
    const box = quadBox(res.model?.content) ?? quadBox(res.model?.border)
    if (!box || box.w <= 0 || box.h <= 0) return undefined
    const off = await frameOffset(page, entry.frameId, signal)
    return { x: Math.round(box.x + box.w / 2 + off.x), y: Math.round(box.y + box.h / 2 + off.y) }
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
}

/** Does another element cover the point? Returns the `BLOCKED:` text when so. */
async function coveredBy(
  page: PageSession,
  located: Located,
  point: { x: number; y: number },
  signal?: AbortSignal,
): Promise<string | undefined> {
  let hit: { backendNodeId?: number; frameId?: string }
  try {
    hit = await call(
      page,
      'DOM.getNodeForLocation',
      {
        x: point.x,
        y: point.y,
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      },
      signal,
    )
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
  const { entry, objectId } = located
  if (hit.backendNodeId === undefined || hit.backendNodeId === entry.backendNodeId) return undefined
  // A hit in another frame cannot be compared with the element's document.
  if (hit.frameId && hit.frameId !== entry.frameId) return undefined
  const hitObject = await objectIdOf(page, hit.backendNodeId, signal)
  if (!hitObject) return undefined
  const res = await call<{ result?: { value?: boolean } }>(
    page,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration:
        'function (h) { return this === h || this.contains(h) || h.contains(this) }',
      arguments: [{ objectId: hitObject }],
      returnByValue: true,
    },
    signal,
  )
  if (res.result?.value !== false) return undefined
  const who = await describeCover(page, hit.backendNodeId, signal)
  return `BLOCKED: ${who} covers ${entry.ref} (a dialog or banner). Close it first.`
}

const COVER_ROLES = new Set([
  'dialog',
  'alertdialog',
  'banner',
  'menu',
  'listbox',
  'tooltip',
  'alert',
])

async function describeCover(
  page: PageSession,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const res = await call<{
      nodes?: Array<{
        ignored?: boolean
        role?: { value?: string }
        name?: { value?: string }
        backendDOMNodeId?: number
      }>
    }>(page, 'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true }, signal)
    const nodes = (res.nodes ?? []).filter((n) => !n.ignored)
    const pick =
      nodes.find((n) => COVER_ROLES.has(String(n.role?.value).toLowerCase())) ??
      nodes.find((n) => n.backendDOMNodeId === backendNodeId)
    const role = String(pick?.role?.value ?? '').toLowerCase()
    if (pick && role && role !== 'generic' && role !== 'none') {
      const name = String(pick.name?.value ?? '').trim()
      return name ? `${role} "${name.slice(0, 60)}"` : role
    }
  } catch {}
  try {
    const res = await call<{ node?: { nodeName?: string } }>(
      page,
      'DOM.describeNode',
      { backendNodeId },
      signal,
    )
    if (res.node?.nodeName) return `<${res.node.nodeName.toLowerCase()}>`
  } catch {}
  return 'another element'
}

const mouse = (
  type: string,
  point: { x: number; y: number },
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type,
  x: point.x,
  y: point.y,
  button: 'left',
  pointerType: 'mouse',
  ...extra,
})

/** Click (or hover) an element: hit-tested pointer events, `el.click()` when it has no box. */
async function pointer(
  page: PageSession,
  located: Located,
  mode: 'click' | 'double' | 'hover',
  signal?: AbortSignal,
): Promise<Outcome | undefined> {
  const point = await pointOf(page, located.entry, signal)
  if (!point) {
    if (mode === 'hover') {
      return failed(
        `ERROR: ${located.entry.ref} has no visible box to hover. Scroll or open it first.`,
      )
    }
    const ok = await callOn<boolean>(
      page,
      located.objectId,
      'function () { this.scrollIntoView({ block: "center" }); this.click(); return true }',
      [],
      signal,
    )
    if (!ok) return failed(`ERROR: ${located.entry.ref} cannot be clicked (it has no box).`)
    return { summary: '', note: "used the element's own click() because it has no box" }
  }
  const blocked = await coveredBy(page, located, point, signal)
  if (blocked) return failed(blocked)
  await call(
    page,
    'Input.dispatchMouseEvent',
    mouse('mouseMoved', point, { button: 'none' }),
    signal,
  )
  if (mode === 'hover') return undefined
  const clicks = mode === 'double' ? 2 : 1
  for (let n = 1; n <= clicks; n++) {
    await call(
      page,
      'Input.dispatchMouseEvent',
      mouse('mousePressed', point, { buttons: 1, clickCount: n }),
      signal,
    )
    await call(
      page,
      'Input.dispatchMouseEvent',
      mouse('mouseReleased', point, { buttons: 0, clickCount: n }),
      signal,
    )
  }
  return undefined
}

async function sendKeys(
  page: PageSession,
  combo: Exclude<ReturnType<typeof parseKeyCombo>, string>,
  signal?: AbortSignal,
): Promise<void> {
  for (const params of keyEvents(combo)) {
    await call(page, 'Input.dispatchKeyEvent', params, signal)
  }
}

async function focusRef(
  page: PageSession,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const located = await locate(page, ref, signal)
  if (typeof located === 'string') return located
  try {
    await call(page, 'DOM.focus', { backendNodeId: located.entry.backendNodeId }, signal)
  } catch (error) {
    if (signal?.aborted) throw error
  }
  return undefined
}

const FILL_FN = `function () {
  const editable = this.isContentEditable || this.tagName === 'TEXTAREA' || (this.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(this.type));
  if (!editable) return this.tagName === 'SELECT' ? 'select' : 'not-editable';
  this.focus();
  try {
    if (typeof this.select === 'function') this.select();
    else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  } catch (e) {}
  return 'ok';
}`

const SELECT_FN = `function (values) {
  if (this.tagName !== 'SELECT') return { error: 'not-select' };
  const want = new Set(values);
  const opts = Array.from(this.options);
  const picked = opts.filter((o) => want.has(o.value) || want.has(o.label) || want.has(o.text.trim()));
  if (picked.length === 0) return { error: 'no-match', options: opts.slice(0, 30).map((o) => o.label || o.value) };
  if (this.multiple) { for (const o of opts) o.selected = picked.includes(o); }
  else this.value = picked[0].value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: picked.map((o) => o.label || o.value) };
}`

const CHECKED_FN = `function () {
  if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) return { checked: this.checked, radio: this.type === 'radio' };
  const a = this.getAttribute('aria-checked');
  if (a === 'true' || a === 'false') return { checked: a === 'true', radio: this.getAttribute('role') === 'radio' };
  return null;
}`

async function perform(page: PageSession, input: ActInput, signal?: AbortSignal): Promise<Outcome> {
  const { kind } = input
  const needsRef = ['click', 'double_click', 'hover', 'fill', 'select', 'check', 'uncheck']
  if (needsRef.includes(kind) && !input.ref) {
    return failed(`ERROR: ${kind} needs a ref from browser_snapshot.`)
  }

  if (kind === 'wait') {
    if (input.untilText) {
      const limit = page.limits.waitMs
      const started = Date.now()
      const probe = `document.body ? document.body.innerText.includes(${JSON.stringify(input.untilText)}) : false`
      while (!signal?.aborted) {
        if ((await evaluate<boolean>(page, probe, signal).catch(() => false)) === true) {
          return { summary: `Found text "${input.untilText.slice(0, 60)}"` }
        }
        if (Date.now() - started >= limit) {
          return failed(
            `ERROR: text "${input.untilText.slice(0, 60)}" did not appear within ${limit} ms.`,
          )
        }
        await sleep(Math.min(200, limit), signal)
      }
      return failed('ERROR: aborted.')
    }
    if (input.ms !== undefined) {
      const ms = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(input.ms)))
      await sleep(ms, signal)
      return { summary: `Waited ${ms} ms` }
    }
    return failed('ERROR: wait needs ms or untilText.')
  }

  if (kind === 'press') {
    if (!input.key) return failed('ERROR: press needs a key such as Enter or Control+a.')
    const combo = parseKeyCombo(input.key)
    if (typeof combo === 'string') return failed(combo)
    if (input.ref) {
      const bad = await focusRef(page, input.ref, signal)
      if (bad) return failed(bad)
    }
    await sendKeys(page, combo, signal)
    return { summary: `Pressed ${input.key}` }
  }

  if (kind === 'type') {
    if (input.text === undefined || input.text === '') return failed('ERROR: type needs text.')
    if (input.ref) {
      const bad = await focusRef(page, input.ref, signal)
      if (bad) return failed(bad)
    }
    for (const ch of input.text) {
      const combo = parseKeyCombo(ch === '\n' ? 'Enter' : ch)
      if (typeof combo === 'string') {
        await call(page, 'Input.insertText', { text: ch }, signal)
      } else await sendKeys(page, combo, signal)
    }
    return {
      summary: `Typed ${[...input.text].length} characters${input.ref ? ` into ${input.ref}` : ''}`,
    }
  }

  if (kind === 'scroll') {
    const dir = input.direction ?? 'down'
    const amount = Math.max(1, Math.min(20_000, Math.floor(input.amount ?? 600)))
    if (input.ref && input.direction === undefined) {
      const located = await locate(page, input.ref, signal)
      if (typeof located === 'string') return failed(located)
      await call(
        page,
        'DOM.scrollIntoViewIfNeeded',
        { backendNodeId: located.entry.backendNodeId },
        signal,
      )
      return { summary: `Scrolled ${input.ref} (${describe(located.entry)}) into view` }
    }
    let at: { x: number; y: number } | undefined
    if (input.ref) {
      const located = await locate(page, input.ref, signal)
      if (typeof located === 'string') return failed(located)
      at = await pointOf(page, located.entry, signal)
    }
    if (!at) {
      const m = await call<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>(
        page,
        'Page.getLayoutMetrics',
        undefined,
        signal,
      )
      at = {
        x: Math.round((m.cssVisualViewport?.clientWidth ?? 800) / 2),
        y: Math.round((m.cssVisualViewport?.clientHeight ?? 600) / 2),
      }
    }
    await call(
      page,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x: at.x,
        y: at.y,
        deltaX: dir === 'left' ? -amount : dir === 'right' ? amount : 0,
        deltaY: dir === 'up' ? -amount : dir === 'down' ? amount : 0,
      },
      signal,
    )
    return { summary: `Scrolled ${dir} ${amount}px` }
  }

  // Everything below acts on a ref.
  const located = await locate(page, input.ref as string, signal)
  if (typeof located === 'string') return failed(located)
  const { entry, objectId } = located
  const who = `${entry.ref} (${describe(entry)})`

  switch (kind) {
    case 'click':
    case 'double_click':
    case 'hover': {
      const mode = kind === 'click' ? 'click' : kind === 'double_click' ? 'double' : 'hover'
      const out = await pointer(page, located, mode, signal)
      if (out?.error) return out
      const verb =
        kind === 'click' ? 'Clicked' : kind === 'double_click' ? 'Double-clicked' : 'Hovered'
      return { summary: `${verb} ${who}`, ...(out?.note ? { note: out.note } : {}) }
    }
    case 'fill': {
      const text = input.text ?? ''
      const state = await callOn<string>(page, objectId, FILL_FN, [], signal)
      if (state === 'select')
        return failed(`ERROR: ${who} is a dropdown. Use kind "select" with values.`)
      if (state !== 'ok') {
        return failed(
          `ERROR: ${who} is not a text field. Use click, or snapshot to find the field.`,
        )
      }
      if (text === '') {
        const combo = parseKeyCombo('Backspace')
        if (typeof combo !== 'string') await sendKeys(page, combo, signal)
      } else await call(page, 'Input.insertText', { text }, signal)
      return {
        summary:
          text === ''
            ? `Cleared ${who}`
            : `Filled ${who} with "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`,
      }
    }
    case 'select': {
      const values = input.values ?? (input.text !== undefined ? [input.text] : [])
      if (values.length === 0)
        return failed('ERROR: select needs values (an option value or label).')
      const res = await callOn<{ error?: string; options?: string[]; selected?: string[] }>(
        page,
        objectId,
        SELECT_FN,
        [values],
        signal,
      )
      if (res?.error === 'not-select') {
        return failed(`ERROR: ${who} is not a <select>. Click it, then click the option.`)
      }
      if (res?.error === 'no-match') {
        return failed(
          `ERROR: no option of ${who} matches ${values.map((v) => `"${v}"`).join(', ')}. Options: ${(res.options ?? []).join(', ')}.`,
        )
      }
      if (!res?.selected) return failed(`ERROR: could not select in ${who}.`)
      return { summary: `Selected ${res.selected.map((s) => `"${s}"`).join(', ')} in ${who}` }
    }
    case 'check':
    case 'uncheck': {
      const want = kind === 'check'
      const state = await callOn<{ checked: boolean; radio: boolean } | null>(
        page,
        objectId,
        CHECKED_FN,
        [],
        signal,
      )
      if (!state) return failed(`ERROR: ${who} is not a checkbox, radio button or switch.`)
      if (state.checked === want) {
        return { summary: `${who} is already ${want ? 'checked' : 'unchecked'}` }
      }
      if (state.radio && !want) {
        return failed(
          `ERROR: ${who} is a radio button; choose another option of its group instead.`,
        )
      }
      const out = await pointer(page, located, 'click', signal)
      if (out?.error) return out
      const after = await callOn<{ checked: boolean } | null>(
        page,
        objectId,
        CHECKED_FN,
        [],
        signal,
      )
      const note =
        after && after.checked !== want
          ? `${entry.ref} did not become ${want ? 'checked' : 'unchecked'}; check the page.`
          : out?.note
      return { summary: `${want ? 'Checked' : 'Unchecked'} ${who}`, ...(note ? { note } : {}) }
    }
    default:
      return failed(`ERROR: unknown action kind "${String(kind)}".`)
  }
}

/**
 * Perform one action and report what happened. Never throws for expected failures: a bad ref,
 * a covered element or a lost connection come back as `error`.
 */
export async function act(
  page: PageSession,
  input: ActInput,
  signal?: AbortSignal,
): Promise<ActResult> {
  let before = { fp: '', loader: '', url: '' }
  try {
    const main = await mainFrame(page, signal)
    before = {
      fp: await fingerprint(page, signal),
      loader: main.loaderId,
      url: (await pageInfo(page, signal)).url,
    }
  } catch {}
  let outcome: Outcome
  try {
    outcome = await perform(page, input, signal)
  } catch (error) {
    outcome = failed(signal?.aborted ? 'ERROR: aborted.' : `ERROR: ${errorText(error)}`)
  }
  if (!outcome.error && input.kind !== 'wait') await settle(page, signal)
  let info = { url: before.url, title: '' }
  let navigated = false
  let changed = false
  try {
    info = await pageInfo(page, signal)
    const main = await mainFrame(page, signal)
    navigated = main.loaderId !== before.loader || info.url !== before.url
    changed = navigated || (await fingerprint(page, signal)) !== before.fp
  } catch {}
  const notes = [outcome.note, ...page.notes.splice(0)].filter((n): n is string => Boolean(n))
  return {
    page: info,
    navigated,
    changed: outcome.error ? false : changed,
    summary: outcome.summary,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  }
}
