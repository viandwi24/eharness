/**
 * Terminal notifications and title: bell, OSC 9 / OSC 777 desktop notifications, an `osascript`
 * fallback for Apple Terminal, and OSC 0 for the window title. Nothing here ever throws.
 */
import { spawn } from 'node:child_process'

/** Injectable I/O for tests. */
export interface NotifyIO {
  write?: (data: string) => void
  spawn?: (command: string, args: string[]) => void
  env?: NodeJS.ProcessEnv
  platform?: string
}

function writer(io: NotifyIO): (data: string) => void {
  return io.write ?? ((data) => void process.stdout.write(data))
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
const CONTROL = /[\u0000-\u001f\u007f]/g

/** Remove control characters (they would end or corrupt an escape sequence). */
function clean(text: string): string {
  return text.replace(CONTROL, ' ')
}

function defaultSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

/** Notify the user that the agent needs attention. `off` does nothing. */
export function notify(text: string, mode: 'off' | 'bell' | 'desktop', io: NotifyIO = {}): void {
  try {
    if (mode === 'off') return
    const write = writer(io)
    if (mode === 'bell') {
      write('\x07')
      return
    }
    const message = clean(text)
    write(`\x1b]9;${message}\x07`)
    write(`\x1b]777;notify;coder;${message.replaceAll(';', ',')}\x07`)
    const env = io.env ?? process.env
    const platform = io.platform ?? process.platform
    if (platform === 'darwin' && env.TERM_PROGRAM === 'Apple_Terminal') {
      const escaped = message.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
      ;(io.spawn ?? defaultSpawn)('osascript', [
        '-e',
        `display notification "${escaped}" with title "coder"`,
      ])
    }
  } catch {
    // notifications are best effort
  }
}

/** Set the terminal window title (OSC 0). */
export function setTerminalTitle(text: string, io: NotifyIO = {}): void {
  try {
    writer(io)(`\x1b]0;${clean(text)}\x07`)
  } catch {
    // best effort
  }
}
