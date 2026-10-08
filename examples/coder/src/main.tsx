#!/usr/bin/env bun
/**
 * `coder`: a terminal coding agent built on eharness (docs/plans/P30-coder-example.md).
 *
 *   bun examples/coder/src/main.tsx --help
 *
 * Offline runs: when the environment variable `CODER_SCRIPTED_MODEL` points to a JSON file with an
 * array of `scriptedModel` steps (`eharness/testing`), that scripted model replaces the real one
 * for the main agent and every subagent. The e2e tests run the CLI this way, without a network.
 */
import { readFile } from 'node:fs/promises'
import { Command, InvalidArgumentError } from 'commander'
import { version as eharnessVersion } from 'eharness'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { type CliFlags, loadConfig } from './app/config.ts'
import { createController } from './app/controller.ts'
import { createDenyingBroker } from './permissions/index.ts'
import { runPrint } from './print.ts'
import { runInteractive } from './ui/run-interactive.tsx'

interface Options extends CliFlags {
  print?: string
  outputFormat?: string
}

function parseSteps(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer')
  return n
}

const program = new Command()
  .name('coder')
  .description('A terminal coding agent built on eharness.')
  .version(`coder 0.0.0 (eharness ${eharnessVersion})`)
  .argument('[prompt]', 'first prompt of the interactive session')
  .option('-p, --print <prompt>', 'run one prompt headless, print the answer and exit')
  .option('--output-format <format>', 'print mode output: text | json | stream-json', 'text')
  .option('--model <id>', 'AI Gateway model id (default from settings)')
  .option('--permission-mode <mode>', 'default | acceptEdits | plan | dontAsk | bypassPermissions')
  .option('--add-dir <path...>', 'extra directories, mounted at /@dirs/<basename>/')
  .option('--allowed-tools <rule...>', 'extra allow rules for this run')
  .option('--disallowed-tools <rule...>', 'extra deny rules for this run')
  .option('--agents <json>', 'session-only subagent definitions (JSON object)')
  .option('-c, --continue', 'continue the most recent session of this project')
  .option('-r, --resume [id]', 'resume a session (picker without an id)')
  .option('--max-steps <n>', 'loop.maxSteps per turn', parseSteps)
  .option('--cwd <path>', 'project root (default: the current directory)')
  .action(async (prompt: string | undefined, options: Options & { continue?: boolean }) => {
    const flags: CliFlags = { ...options }

    let config: Awaited<ReturnType<typeof loadConfig>>
    try {
      config = await loadConfig(flags)
    } catch (error) {
      process.stderr.write(`coder: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(2)
    }

    let model: ReturnType<typeof scriptedModel> | undefined
    const scriptFile = process.env.CODER_SCRIPTED_MODEL
    if (scriptFile) {
      try {
        const steps = JSON.parse(await readFile(scriptFile, 'utf8')) as ScriptedStepInput[]
        model = scriptedModel(steps)
      } catch (error) {
        process.stderr.write(
          `coder: cannot load CODER_SCRIPTED_MODEL ${scriptFile}: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exit(2)
      }
    }

    if (config.print !== undefined) {
      // never prompts: anything that would ask is denied, unless everything is allowed anyway
      const controller = await createController({
        config,
        model,
        broker: createDenyingBroker(),
      })
      for (const warning of config.warnings) process.stderr.write(`coder: warning: ${warning}\n`)
      let code = 1
      try {
        code = await runPrint(controller, config.print)
      } finally {
        await controller.close()
      }
      process.exit(code)
    }

    const controller = await createController({ config, model })
    for (const warning of config.warnings) process.stderr.write(`coder: warning: ${warning}\n`)
    await runInteractive(controller, { initialPrompt: prompt })
    process.exit(0)
  })

await program.parseAsync()
