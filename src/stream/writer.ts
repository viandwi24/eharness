/**
 * Namespaced plugin stream writers (internal).
 *
 * @see docs/specs/04-streaming.md#3-plugin-stream-writer
 */
import type { UIMessageChunk } from 'ai'
import type { DataChunk } from '../messages/data-parts.ts'
import type { PluginStreamWriter } from '../plugin/types.ts'
import type { SessionRuntime } from '../session/runtime.ts'

/** Data part types only the core writes (spec 04 §2). */
const CORE_ONLY: ReadonlySet<string> = new Set(['data-eh.input'])

/**
 * Write a data chunk on behalf of a plugin (or the core): registry check, transient default and
 * override warning, in-turn write or out-of-turn routing.
 */
export function writeDataChunk(
  rt: SessionRuntime,
  chunk: DataChunk,
  transientOption: boolean | undefined,
): void {
  const registered = CORE_ONLY.has(chunk.type) ? undefined : rt.agent.messages.dataPart(chunk.type)
  if (registered === undefined) {
    rt.warn(
      {
        code: 'W_UNKNOWN_DATA_PART',
        message: CORE_ONLY.has(chunk.type)
          ? `Data part '${chunk.type}' is written only by the core; dropped.`
          : `Data part '${chunk.type}' is not registered; dropped.`,
        details: { type: chunk.type },
      },
      chunk.type,
    )
    return
  }
  const definedTransient = registered.def.transient === true
  if (definedTransient && transientOption === false) {
    rt.warn(
      {
        code: 'W_TRANSIENT_OVERRIDE',
        message: `Data part '${chunk.type}' is defined as transient; sent as transient.`,
        details: { type: chunk.type },
      },
      chunk.type,
    )
  }
  const transient = definedTransient || transientOption === true
  const out = {
    type: chunk.type,
    ...(chunk.id === undefined ? {} : { id: chunk.id }),
    data: chunk.data,
    ...(transient ? { transient: true } : {}),
  } as UIMessageChunk & DataChunk
  const turn = rt.turn
  if (turn?.active === true) {
    turn.write(out)
    return
  }
  if (transient) {
    rt.events.emit({ type: 'data', chunk: out as never })
    return
  }
  rt.warn(
    {
      code: 'W_WRITE_OUTSIDE_TURN',
      message: `Persistent data part '${chunk.type}' written outside a turn; dropped (use session.inject for durable out-of-turn content).`,
      details: { type: chunk.type },
    },
    chunk.type,
  )
}

/** Create the namespaced stream writer of one plugin (`'app'` = no namespace). */
export function createPluginWriter(rt: SessionRuntime, plugin: string): PluginStreamWriter {
  const prefix = plugin === 'app' ? '' : `${plugin}.`
  return {
    get active() {
      return rt.turn?.active === true
    },
    data(name, data, opts) {
      writeDataChunk(
        rt,
        {
          type: `data-${prefix}${String(name)}`,
          ...(opts?.id === undefined ? {} : { id: opts.id }),
          data,
        },
        opts?.transient,
      )
    },
    write(chunk) {
      writeDataChunk(rt, chunk, chunk.transient)
    },
  }
}
