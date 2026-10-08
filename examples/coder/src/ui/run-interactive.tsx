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
  const instance = render(
    <App
      controller={controller}
      initialPrompt={opts.initialPrompt}
      initialMessages={initialMessages}
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
