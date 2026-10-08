#!/usr/bin/env bun
/**
 * `coder`: a terminal coding agent built on eharness (docs/plans/P30-coder-example.md).
 *
 *   bun examples/coder/src/main.tsx --help
 *
 * M1 skeleton: the Commander program and the Ink entry. The agent, workspace, permissions and
 * subagents land in the milestones of the plan.
 */
import { Command } from 'commander'
import { version as eharnessVersion } from 'eharness'
import { Box, render, Text } from 'ink'

function Splash({ cwd }: { cwd: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>coder</Text>
      <Text dimColor>
        eharness {eharnessVersion} · {cwd}
      </Text>
    </Box>
  )
}

const program = new Command()
  .name('coder')
  .description('A terminal coding agent built on eharness.')
  .version(`coder 0.0.0 (eharness ${eharnessVersion})`)
  .argument('[prompt]', 'first prompt of the interactive session')
  .option('-p, --print <prompt>', 'run one prompt headless and print the answer')
  .option('--cwd <path>', 'project root', process.cwd())
  .action((_prompt: string | undefined, options: { print?: string; cwd: string }) => {
    if (options.print !== undefined) {
      console.log(`coder: print mode is not implemented yet (eharness ${eharnessVersion})`)
      return
    }
    const app = render(<Splash cwd={options.cwd} />)
    app.unmount()
  })

await program.parseAsync()
