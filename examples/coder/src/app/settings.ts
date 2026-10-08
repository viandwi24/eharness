/**
 * The `/config` backend: a list of editable settings with their effective value and source, and
 * validated read-modify-write updates of the user (`~/.coder/settings.json`) and project-local
 * (`<root>/.coder/settings.local.json`) files. Other keys of the file are never touched.
 *
 * `model`, `provider` and `thinking` live in the per-project preferences file, not in the
 * settings files (see `preferences.ts`); `updateSetting` writes them there (scope is ignored) and
 * the integrator applies them through `deps.apply`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type CoderConfig,
  type CoderSettings,
  PERMISSION_MODES,
  type SettingView,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../contracts.ts'
import { mergeSettings, readSettingsLayers, type SettingsLayer } from './config.ts'
import { loadPreferences, savePreferences } from './preferences.ts'
import { MODEL_PROVIDERS } from './provider.ts'

/** What the manager needs to know about the running session. */
export interface SettingsDeps {
  config: Pick<
    CoderConfig,
    'root' | 'userDir' | 'projectDataDir' | 'settingsFiles' | 'mode' | 'provider' | 'model'
  > & {
    /** Merged settings at startup (`LoadedConfig.settings`). */
    settings?: CoderSettings
    modelExplicit?: boolean
  }
  /** Current thinking level and model of the controller (they change at runtime). */
  current?(): { provider: string; model: string; thinking: ThinkingLevel; mode?: string }
  /** Output style names for the `outputStyle` options. Default: the four built-ins. */
  outputStyleNames?(): Promise<string[]>
  /**
   * Apply a changed setting to the running app (permissions mode, model, thinking, sandbox…).
   * `key` is the setting key (`sandbox.enabled`, `permissions.defaultMode`, `model`, …).
   */
  apply?(key: string, value: unknown): void | Promise<void>
}

export interface SettingsManager {
  settings(): Promise<SettingView[]>
  updateSetting(key: string, value: unknown, scope: 'user' | 'local'): Promise<void>
  /** Merged value of a top-level key (sync; refreshed after every update). */
  setting<K extends keyof CoderSettings>(key: K): CoderSettings[K]
  /** Fires after a successful update. */
  onChange(listener: (key: string, value: unknown, scope: 'user' | 'local') => void): () => void
}

type Kind = SettingView['type']
interface Descriptor {
  key: string
  label: string
  description: string
  type: Kind
  options?: string[]
  default: unknown
  /** Where it is stored; `prefs` = the per-project preferences file. */
  store: 'settings' | 'prefs'
  parse(value: unknown): unknown
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('expected true or false')
}

function oneOf<T extends string>(options: readonly T[]): (value: unknown) => T {
  return (value) => {
    if (typeof value === 'string' && (options as readonly string[]).includes(value))
      return value as T
    throw new Error(`expected one of: ${options.join(', ')}`)
  }
}

function nonNegative(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new Error('expected a number of at least 0')
  }
  return n
}

const DESCRIPTORS: Descriptor[] = [
  {
    key: 'model',
    label: 'Model',
    description: 'Model id used for the next turn (saved per project).',
    type: 'string',
    default: undefined,
    store: 'prefs',
    parse: (v) => {
      if (typeof v !== 'string' || v.trim() === '') throw new Error('expected a model id')
      return v.trim()
    },
  },
  {
    key: 'provider',
    label: 'Provider',
    description: 'Where model calls go (saved per project).',
    type: 'enum',
    options: [...MODEL_PROVIDERS],
    default: undefined,
    store: 'prefs',
    parse: oneOf(MODEL_PROVIDERS),
  },
  {
    key: 'thinking',
    label: 'Thinking',
    description: 'Reasoning effort of the model (saved per project).',
    type: 'enum',
    options: [...THINKING_LEVELS],
    default: 'provider-default',
    store: 'prefs',
    parse: oneOf(THINKING_LEVELS),
  },
  {
    key: 'permissions.defaultMode',
    label: 'Default permission mode',
    description: 'Mode a new session starts in.',
    type: 'enum',
    options: [...PERMISSION_MODES],
    default: 'default',
    store: 'settings',
    parse: oneOf(PERMISSION_MODES),
  },
  {
    key: 'theme',
    label: 'Theme',
    description: 'Colour palette of the terminal UI (`auto` reads COLORFGBG).',
    type: 'enum',
    options: ['dark', 'light', 'auto'],
    default: 'dark',
    store: 'settings',
    parse: oneOf(['dark', 'light', 'auto'] as const),
  },
  {
    key: 'outputStyle',
    label: 'Output style',
    description: 'How the agent words its answers.',
    type: 'enum',
    options: ['default', 'concise', 'explanatory', 'learning'],
    default: 'default',
    store: 'settings',
    parse: (v) => {
      if (typeof v !== 'string' || v.trim() === '') throw new Error('expected a style name')
      return v.trim()
    },
  },
  {
    key: 'notifications',
    label: 'Notifications',
    description: 'Bell or desktop notification when a turn ends or input is needed.',
    type: 'enum',
    options: ['off', 'bell', 'desktop'],
    default: 'bell',
    store: 'settings',
    parse: oneOf(['off', 'bell', 'desktop'] as const),
  },
  {
    key: 'askUserQuestionTimeout',
    label: 'Question timeout (s)',
    description: 'Dismiss unanswered questions from the agent after this many seconds (0 = never).',
    type: 'number',
    default: 0,
    store: 'settings',
    parse: nonNegative,
  },
  {
    key: 'promptSuggestions',
    label: 'Prompt suggestions',
    description: 'Suggest the next prompt after each turn (one cheap model call).',
    type: 'boolean',
    default: false,
    store: 'settings',
    parse: bool,
  },
  {
    key: 'editorMode',
    label: 'Editor mode',
    description: 'Key bindings of the prompt editor.',
    type: 'enum',
    options: ['normal', 'vim'],
    default: 'normal',
    store: 'settings',
    parse: oneOf(['normal', 'vim'] as const),
  },
  {
    key: 'sandbox.enabled',
    label: 'Sandbox',
    description: 'Run bash commands in an OS sandbox (writes limited to the project).',
    type: 'boolean',
    default: false,
    store: 'settings',
    parse: bool,
  },
  {
    key: 'sandbox.network',
    label: 'Sandbox network',
    description: 'Allow network access for sandboxed commands.',
    type: 'boolean',
    default: false,
    store: 'settings',
    parse: bool,
  },
  {
    key: 'statusLine.command',
    label: 'Status line command',
    description: 'Shell command whose first output line is shown in the footer (empty = off).',
    type: 'string',
    default: '',
    store: 'settings',
    parse: (v) => {
      if (typeof v !== 'string') throw new Error('expected a command')
      return v.trim()
    },
  },
]

/** Keys `updateSetting` accepts. */
export const SETTING_KEYS: readonly string[] = DESCRIPTORS.map((d) => d.key)

function getPath(obj: unknown, path: string): unknown {
  let cur = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  const last = parts.pop() as string
  const trail: Array<[Record<string, unknown>, string]> = []
  let cur = obj
  for (const part of parts) {
    trail.push([cur, part])
    const next = cur[part]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[part] = {}
    cur = cur[part] as Record<string, unknown>
  }
  if (value === undefined) {
    delete cur[last]
    // prune parents that became empty
    for (let i = trail.length - 1; i >= 0; i--) {
      const [holder, key] = trail[i] as [Record<string, unknown>, string]
      if (Object.keys(holder[key] as object).length === 0) delete holder[key]
      else break
    }
  } else cur[last] = value
}

async function readRaw(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); fix it by hand first`)
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${file} must contain a JSON object`)
  }
  return json as Record<string, unknown>
}

/** Create the settings manager. */
export function createSettingsManager(deps: SettingsDeps): SettingsManager {
  const { config } = deps
  let merged: CoderSettings = config.settings ?? {}
  const listeners = new Set<(key: string, value: unknown, scope: 'user' | 'local') => void>()

  const refresh = async (): Promise<SettingsLayer[]> => {
    const layers = await readSettingsLayers(config)
    merged = mergeSettings(layers.map((l) => l.settings))
    return layers
  }

  return {
    async settings() {
      const layers = await refresh()
      const prefs = await loadPreferences(config.projectDataDir)
      const current = deps.current?.()
      const styleNames = (await deps.outputStyleNames?.()) ?? undefined
      return DESCRIPTORS.map((d): SettingView => {
        let value: unknown
        let source: SettingView['source'] = 'default'
        if (d.store === 'prefs') {
          const k = d.key as 'model' | 'provider' | 'thinking'
          value =
            current?.[k] ??
            prefs[k] ??
            (k === 'thinking' ? d.default : config[k as 'model' | 'provider'])
          if (prefs[k] !== undefined) source = 'local'
          else if (k !== 'thinking' && config.modelExplicit) source = 'flag'
        } else {
          value = getPath(merged, d.key)
          for (const layer of layers) {
            if (getPath(layer.settings, d.key) !== undefined) source = layer.scope
          }
          if (d.key === 'permissions.defaultMode' && value === undefined) {
            value = current?.mode ?? config.mode
            if (config.mode !== 'default') source = 'flag'
          }
          value ??= d.default
        }
        const view: SettingView = {
          key: d.key,
          label: d.label,
          description: d.description,
          type: d.type,
          value,
          source,
        }
        const options = d.key === 'outputStyle' && styleNames ? styleNames : d.options
        if (options !== undefined) view.options = options
        return view
      })
    },
    async updateSetting(key, value, scope) {
      const d = DESCRIPTORS.find((x) => x.key === key)
      if (d === undefined) {
        throw new Error(`Unknown setting "${key}". Known: ${SETTING_KEYS.join(', ')}`)
      }
      let parsed: unknown
      try {
        parsed = d.parse(value)
      } catch (error) {
        throw new Error(`Invalid value for ${key}: ${(error as Error).message}`)
      }
      if (d.store === 'prefs') {
        await savePreferences(config.projectDataDir, { [key]: parsed })
      } else {
        const file = scope === 'user' ? config.settingsFiles.user : config.settingsFiles.local
        const raw = await readRaw(file)
        // an empty status line command removes the whole `statusLine` object
        const clear = key === 'statusLine.command' && parsed === ''
        setPath(raw, key, clear ? undefined : parsed)
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`)
        await rename(temp, file)
        await refresh()
      }
      await deps.apply?.(key, parsed)
      for (const listener of [...listeners]) {
        try {
          listener(key, parsed, scope)
        } catch {
          // listeners must not break an update
        }
      }
    },
    setting: (key) => merged[key],
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
