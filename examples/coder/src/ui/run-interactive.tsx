import { render } from 'ink'
import type { CoderController } from '../contracts.ts'
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
  const instance = render(<App controller={controller} initialPrompt={opts.initialPrompt} />, {
    incrementalRendering: true,
    exitOnCtrlC: false,
  })
  try {
    await instance.waitUntilExit()
  } finally {
    await controller.close()
  }
}
