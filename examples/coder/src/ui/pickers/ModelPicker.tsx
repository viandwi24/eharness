/** `/model` and Alt+P: pick a model with type-to-filter search; a custom id can be typed. */
import { Box, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useMemo, useState } from 'react'
import type { CoderController, ModelOption, ThinkingLevel } from '../../contracts.ts'
import { fmtPrice, fmtTokens } from '../pages/format.ts'
import { moveIndex, selectAction } from '../select.ts'
import { color, sym } from '../theme.ts'
import { PickerFrame, VISIBLE_ROWS, windowStart } from './PickerFrame.tsx'

/** One row of the list. */
export type ModelRow =
  | { kind: 'model'; option: ModelOption; selectable: boolean }
  | { kind: 'custom'; id: string }

/** Models whose name or id contains every word of `query` (case-insensitive), order kept. */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return models
  return models.filter((m) => {
    const hay = `${m.name} ${m.id}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** The rows for `query`: matching models, then a "use custom id" row when nothing matches exactly. */
export function modelRows(models: ModelOption[], query: string): ModelRow[] {
  const rows: ModelRow[] = filterModels(models, query).map((option) => ({
    kind: 'model',
    option,
    selectable: option.tools,
  }))
  const id = query.trim()
  if (id && !models.some((m) => m.id === id)) rows.push({ kind: 'custom', id })
  return rows
}

function selectable(row: ModelRow | undefined): boolean {
  return !!row && (row.kind === 'custom' || row.selectable)
}

function firstSelectable(rows: ModelRow[], current?: string): number {
  const at = rows.findIndex((r) => r.kind === 'model' && r.option.id === current && r.selectable)
  if (at >= 0) return at
  return Math.max(
    0,
    rows.findIndex((r) => selectable(r)),
  )
}

/** Props of {@link ModelPicker}. */
export interface ModelPickerProps {
  controller: CoderController
  /**
   * Enter applies; `thinking` is the effort chosen with Left/Right (only for a model that
   * reasons); `sessionOnly` is set by `s` (do not save the choice as the project preference).
   */
  onSelect(id: string, opts?: { thinking?: ThinkingLevel; sessionOnly?: boolean }): void
  onCancel(): void
}

/** The levels of the effort slider, lowest first. */
const EFFORT_LEVELS: ThinkingLevel[] = ['none', 'low', 'medium', 'high', 'xhigh']

/** Slider levels for a current level (a level outside the slider, e.g. `minimal`, is kept in place). */
export function effortLevels(current: ThinkingLevel): ThinkingLevel[] {
  if (current === 'provider-default' || EFFORT_LEVELS.includes(current)) return EFFORT_LEVELS
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
}

/** The slider row: `Thinking: ○ none ○ low ● medium ○ high`. */
export function effortLine(levels: ThinkingLevel[], level: ThinkingLevel): string {
  const marks = levels.map((l) => `${l === level ? '●' : '○'} ${l}`).join(' ')
  return level === 'provider-default'
    ? `Thinking: ${marks} (provider default)`
    : `Thinking: ${marks}`
}

/** Inline model picker. */
export function ModelPicker({ controller, onSelect, onCancel }: ModelPickerProps): ReactElement {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  const [offline, setOffline] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const current = controller.model
  const [filtering, setFiltering] = useState(false)
  const [effort, setEffort] = useState<ThinkingLevel>(controller.thinking)
  const levels = effortLevels(controller.thinking)

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    let cancelled = false
    controller
      .models()
      .then((list) => {
        if (cancelled) return
        setModels(list)
        setOffline(list.length === 0)
        setIndex(firstSelectable(modelRows(list, ''), current))
      })
      .catch(() => {
        if (cancelled) return
        setModels([])
        setOffline(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const rows = useMemo(() => modelRows(models ?? [], query), [models, query])
  const move = (dir: 1 | -1): void => {
    let next = index
    for (;;) {
      next += dir
      if (next < 0 || next >= rows.length) return
      if (selectable(rows[next])) {
        setIndex(next)
        return
      }
    }
  }

  const highlighted = rows[Math.min(index, Math.max(0, rows.length - 1))]
  // a custom id is assumed to reason; a listed model says so
  const reasons = highlighted?.kind === 'custom' || highlighted?.option.reasoning === true

  const apply = (sessionOnly: boolean): void => {
    const row = rows[index]
    if (!row || !selectable(row)) return
    onSelect(row.kind === 'custom' ? row.id : row.option.id, {
      ...(reasons ? { thinking: effort } : {}),
      ...(sessionOnly ? { sessionOnly: true } : {}),
    })
  }

  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (models === null) return
    // the list filters as you type: j/k are text here, the arrows and Ctrl+N/P move
    const action = selectAction(input, key, { letters: false })
    if (action === 'next') return move(1)
    if (action === 'previous') return move(-1)
    if (action === 'pageDown' || action === 'pageUp' || action === 'first' || action === 'last') {
      const target = moveIndex(index, rows.length, action, VISIBLE_ROWS)
      const dir = target >= index ? 1 : -1
      for (let i = target; i >= 0 && i < rows.length; i += dir) {
        if (selectable(rows[i])) return setIndex(i)
      }
      return
    }
    if (action === 'accept') return apply(false)
    if (key.leftArrow || key.rightArrow) {
      if (!reasons) return
      const at = levels.indexOf(effort)
      // from the provider default (not on the slider) either arrow lands on the first mark
      const next =
        at < 0 ? 0 : Math.max(0, Math.min(levels.length - 1, at + (key.rightArrow ? 1 : -1)))
      const level = levels[next]
      if (level) setEffort(level)
      return
    }
    // `s` applies for this session only, unless the filter is already in use (`/` opens it
    // explicitly, for a query that starts with an s)
    if (input === '/' && query === '' && !filtering) return setFiltering(true)
    if (input === 's' && !key.ctrl && !key.meta && query === '' && !filtering) return apply(true)
    if (key.backspace || key.delete) {
      const next = query.slice(0, -1)
      setQuery(next)
      return setIndex(firstSelectable(modelRows(models, next), current))
    }
    if (key.ctrl || key.meta || key.tab || !input) return
    const next = query + input.replace(/[\r\n\t]/g, '')
    setQuery(next)
    setIndex(firstSelectable(modelRows(models, next), current))
  })

  if (models === null) {
    return (
      <PickerFrame title="Select model" hint="esc cancel">
        <Text dimColor>Loading models…</Text>
      </PickerFrame>
    )
  }
  const at = Math.min(index, Math.max(0, rows.length - 1))
  const first = windowStart(at, rows.length)
  const shown = rows.slice(first, first + VISIBLE_ROWS)
  return (
    <PickerFrame
      title="Select model"
      hint={
        offline
          ? 'type a model id · enter use it · esc cancel'
          : '↑/↓ select · ←/→ thinking · type to filter · enter apply · s this session only · esc cancel'
      }
    >
      <Text>
        <Text color={color.accent}>search </Text>
        {query}
        <Text inverse> </Text>
      </Text>
      {offline ? (
        <Text color={color.warning}>Model list unavailable (offline?). Type a model id.</Text>
      ) : null}
      {!offline && rows.length === 0 ? <Text dimColor>No matching models.</Text> : null}
      {first > 0 ? <Text dimColor> ↑ {first} more</Text> : null}
      {shown.map((row, i) => {
        const selected = first + i === at
        const pointer = selected ? sym.pointer : ' '
        if (row.kind === 'custom') {
          return (
            <Text key="custom" wrap="truncate-end" color={selected ? color.accent : undefined}>
              {pointer} Use custom id <Text bold>{row.id}</Text>
            </Text>
          )
        }
        const m = row.option
        const isCurrent = m.id === current
        const dim = !row.selectable
        return (
          <Box key={m.id}>
            <Text
              wrap="truncate-end"
              color={selected ? color.accent : undefined}
              dimColor={dim && !selected}
            >
              {pointer} {isCurrent ? '✓' : ' '} {m.name}
              <Text dimColor>
                {'  '}
                {m.id}
                {m.contextWindow ? `  ctx ${fmtTokens(m.contextWindow)}` : ''}
                {m.pricing ? `  $${fmtPrice(m.pricing.input)}/$${fmtPrice(m.pricing.output)}` : ''}
                {m.reasoning ? '  ⚙ thinking' : ''}
                {dim ? '  no tools' : ''}
              </Text>
            </Text>
          </Box>
        )
      })}
      {first + VISIBLE_ROWS < rows.length ? (
        <Text dimColor> ↓ {rows.length - first - VISIBLE_ROWS} more</Text>
      ) : null}
      {!offline && rows.length > 0 ? (
        <Box marginTop={1}>
          {reasons ? (
            <Text>
              <Text color={color.accent}>{effortLine(levels, effort)}</Text>
              <Text dimColor> ←/→</Text>
            </Text>
          ) : (
            <Text dimColor>Thinking: not supported by this model</Text>
          )}
        </Box>
      ) : null}
    </PickerFrame>
  )
}
