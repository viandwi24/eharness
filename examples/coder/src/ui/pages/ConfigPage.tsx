/** `/config`: edit settings. ↑↓ select, Enter/Space toggle or edit, `u` / `l` choose the scope. */
import { Box, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { CoderController, SettingView } from '../../contracts.ts'
import { moveIndex, selectAction } from '../select.ts'
import { color, sym } from '../theme.ts'
import { Loading, Page } from './Page.tsx'

/** Settings that belong to the user, not the project, unless a scope is chosen. */
const USER_KEYS = new Set(['theme', 'editorMode', 'notifications'])

/** Default scope for a key. */
export function defaultScope(key: string): 'user' | 'local' {
  return USER_KEYS.has(key) ? 'user' : 'local'
}

/** Next value of an enum, wrapping. */
export function cycle(options: string[], value: unknown): string {
  const i = options.indexOf(String(value))
  return options[(i + 1) % options.length] ?? ''
}

function show(view: SettingView): string {
  if (view.value === undefined || view.value === null || view.value === '') return '(unset)'
  return typeof view.value === 'string' ? view.value : JSON.stringify(view.value)
}

/** Props of {@link ConfigPage}. */
export interface ConfigPageProps {
  controller: CoderController
  onClose(): void
  /** A setting was saved (the App re-applies theme, editor mode, …). */
  onSaved?(key: string, value: unknown): void
  size?: { rows: number; columns: number }
}

/** The config page. */
export function ConfigPage({ controller, onClose, onSaved, size }: ConfigPageProps): ReactElement {
  const [items, setItems] = useState<SettingView[] | null>(null)
  const [index, setIndex] = useState(0)
  const [scope, setScope] = useState<'user' | 'local' | null>(null)
  const [edit, setEdit] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const reload = (): void => {
    controller
      .settings()
      .then((list) => alive.current && setItems(list))
      .catch((e: unknown) => alive.current && setNote(e instanceof Error ? e.message : String(e)))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(reload, [])

  const save = (view: SettingView, value: unknown): void => {
    const target = scope ?? defaultScope(view.key)
    controller.updateSetting(view.key, value, target).then(
      () => {
        if (!alive.current) return
        setNote(`Saved ${view.key} (${target}).`)
        onSaved?.(view.key, value)
        reload()
      },
      (e: unknown) =>
        alive.current && setNote(`Cannot save: ${e instanceof Error ? e.message : e}`),
    )
  }

  useInput(
    (input, key) => {
      if (!items) return
      const view = items[index]
      if (edit !== null && view) {
        if (key.escape) return setEdit(null)
        if (key.return) {
          const text = edit
          setEdit(null)
          if (view.type === 'number') {
            const n = Number(text)
            if (text.trim() === '' || !Number.isFinite(n)) return setNote('Not a number.')
            return save(view, n)
          }
          return save(view, text)
        }
        if (key.backspace || key.delete) return setEdit((t) => (t ?? '').slice(0, -1))
        if (input && !key.ctrl && !key.meta) setEdit((t) => (t ?? '') + input)
        return
      }
      const action = selectAction(input, key)
      if (action && action !== 'accept' && action !== 'cancel') {
        setIndex((i) => moveIndex(i, items.length, action))
      } else if (input === 'u') setScope('user')
      else if (input === 'l') setScope('local')
      else if ((key.return || input === ' ') && view) {
        if (view.type === 'boolean') save(view, !view.value)
        else if (view.type === 'enum' && view.options?.length)
          save(view, cycle(view.options, view.value))
        else if (key.return) setEdit(view.value === undefined ? '' : String(view.value))
      }
    },
    { isActive: items !== null },
  )

  const current = items?.[index]
  const hint =
    edit !== null
      ? 'type a value · enter save · esc cancel'
      : 'esc/q close · ↑↓/jk select · enter/space change · u user · l project-local'
  return (
    <Page
      title="Config"
      subtitle={`saves to ${scope ?? (current ? defaultScope(current.key) : 'local')}`}
      hints={hint}
      arrows={false}
      editing={edit !== null}
      onClose={onClose}
      size={size}
    >
      {!items ? <Loading /> : null}
      {items?.map((v, i) => (
        <Box key={v.key} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
          <Text wrap="truncate-end" color={i === index ? color.accent : undefined}>
            {i === index ? sym.pointer : ' '} {v.label.padEnd(26)}
            {i === index && edit !== null ? `${edit}▏` : show(v)}
            <Text dimColor> [{v.source}]</Text>
          </Text>
          {i === index ? (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {v.description}
              {v.options ? ` (${v.options.join(' | ')})` : ''}
            </Text>
          ) : null}
        </Box>
      ))}
      {note ? (
        <Box marginTop={1}>
          <Text dimColor>{note}</Text>
        </Box>
      ) : null}
    </Page>
  )
}
