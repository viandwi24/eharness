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
import { createInterface } from 'node:readline/promises'
import { Command, CommanderError, InvalidArgumentError } from 'commander'
import { version as eharnessVersion } from 'eharness'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { type CliFlags, loadConfig, trustProject } from './app/config.ts'
import { createController } from './app/controller.ts'
import { createDenyingBroker } from './permissions/index.ts'
import { runPrint } from './print.ts'
import { killAllSandboxProcesses } from './shell/index.ts'
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

/** Ask a yes/no question on stderr/stdin; anything but `y`/`yes` is no. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

let activeController: { abort(): void } | undefined
let shuttingDown = false

/** Abort the running turn, stop every sandbox process group and exit. */
function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    activeController?.abort()
  } catch {
    // exiting anyway
  }
  killAllSandboxProcesses('SIGTERM')
  killAllSandboxProcesses('SIGKILL')
  process.exit(code)
}

// last resort on any exit: no command of ours outlives the process
process.on('exit', () => killAllSandboxProcesses('SIGKILL'))
process.on('SIGTERM', () => shutdown(143))
const onSigint = (): void => shutdown(130)

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
  .option(
    '--trust-project',
    "trust this project's .coder/ settings, agents and skills (use in print mode and CI)",
  )
  .exitOverride()
  .action(
    async (
      prompt: string | undefined,
      options: Options & { continue?: boolean; trustProject?: boolean },
    ) => {
      const flags: CliFlags = { ...options }

      let config: Awaited<ReturnType<typeof loadConfig>>
      try {
        config = await loadConfig(flags)
      } catch (error) {
        process.stderr.write(`coder: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(2)
      }

      if (!config.trusted && config.untrusted.length > 0 && config.print === undefined) {
        if (process.stdin.isTTY) {
          const yes = await confirm(
            `This project's .coder/ settings want to: ${config.untrusted.join(', ')}.\nTrust this project? [y/N] `,
          )
          if (yes) {
            try {
              await trustProject(config)
              config = await loadConfig(flags)
            } catch (error) {
              process.stderr.write(
                `coder: cannot trust the project: ${error instanceof Error ? error.message : String(error)}\n`,
              )
            }
          }
        }
      }
      if (!config.trusted && config.untrusted.length > 0) {
        process.stderr.write(
          `coder: warning: ignoring untrusted project settings (${config.untrusted.join(', ')}); pass --trust-project to use them\n`,
        )
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
        activeController = controller
        process.on('SIGINT', onSigint)
        let code = 1
        try {
          code = await runPrint(controller, config.print)
        } finally {
          await controller.close()
        }
        killAllSandboxProcesses('SIGKILL')
        process.exit(code)
      }

      const controller = await createController({ config, model })
      for (const warning of config.warnings) process.stderr.write(`coder: warning: ${warning}\n`)
      activeController = controller
      await runInteractive(controller, { initialPrompt: prompt })
      process.on('SIGINT', onSigint)
      shutdown(0)
    },
  )

try {
  await program.parseAsync()
} catch (error) {
  // usage errors (unknown flag, invalid value) exit 2; --help and --version exit 0
  if (error instanceof CommanderError) {
    process.exit(error.exitCode === 0 ? 0 : 2)
  }
  throw error
}
