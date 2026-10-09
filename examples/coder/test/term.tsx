/** Test helper: like `ink-testing-library`'s `render`, but with a configurable column count. */
import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import type { ReactElement } from 'react'

class Stdout extends EventEmitter {
  frames: string[] = []
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
  write = (frame: string): void => {
    this.frames.push(frame)
  }
}

class Stdin extends EventEmitter {
  isTTY = true
  data: string | null = null
  write = (data: string): void => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
}

export function renderAt(tree: ReactElement, columns: number, rows = 40) {
  const stdout = new Stdout(columns, rows)
  const stdin = new Stdin()
  const instance = inkRender(tree, {
    stdout: stdout as never,
    stderr: new Stdout(columns, rows) as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return {
    stdin,
    frames: stdout.frames,
    lastFrame: (): string => stdout.frames[stdout.frames.length - 1] ?? '',
    unmount: (): void => {
      instance.unmount()
      instance.cleanup()
    },
  }
}
