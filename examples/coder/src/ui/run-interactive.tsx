import { render } from 'ink'
import type { CoderController, CoderMessage } from '../contracts.ts'
import { App } from './App.tsx'

/**
 * Run the interactive UI until the user exits. Closes the controller afterwards.
 *
 * @param controller The app controller.
 * @param opts `initialPrompt` is sent as the first prompt.
 */
export async function runInteractive(
  controller: CoderController,
  opts: { initialPrompt?: string } = {},
): Promise<void> {
  // `--continue` / `--resume <id>`: the session already has messages, show them from the start
  let initialMessages: CoderMessage[] = []
  if (controller.config.resume !== true) {
    try {
      initialMessages = await controller.messages()
    } catch {
      // an unreadable session starts empty
    }
  }
  // the welcome box is printed once, so its version has to be known before the first frame
  let version: string | undefined
  try {
    version = (await controller.status()).version
  } catch {
    // no version in the banner
  }
  // Pages switch to the terminal's alternate screen themselves (see ui/pages/host.ts), so Ink's
  // own `alternateScreen` option stays off: the conversation lives in the primary scrollback.
  const instance = render(
    <App
      controller={controller}
      initialPrompt={opts.initialPrompt}
      initialMessages={initialMessages}
      {...(version ? { version } : {})}
    />,
    {
      incrementalRendering: true,
      exitOnCtrlC: false,
    },
  )
  try {
    await instance.waitUntilExit()
  } finally {
    await controller.close()
  }
}
