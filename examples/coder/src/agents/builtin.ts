/** Built-in subagent definitions. Each prompt is the body that follows the shared preamble. */
import { type AgentDefinition, READ_ONLY_TOOLS, TOOL } from '../contracts.ts'

const GENERAL_PURPOSE_PROMPT = `You handle complex, multi-step tasks that need both exploration and changes.

- Start by locating the relevant code (grep, glob), then read only what you need.
- Make the changes that were asked for, no more. Follow the conventions of the surrounding code.
- Verify your work when the project has a quick check (tests, type check, lint) and report the result.
- Finish with a report: what you found, what you changed (file paths), and anything left open.`

const EXPLORE_PROMPT = `You are a fast, read-only codebase search and analysis specialist. You cannot and must not modify anything.

- The caller states a thoroughness level: "quick" (one or two targeted searches), "medium" (a few angles, follow the main references) or "very thorough" (several naming conventions and locations, trace callers and callees). Default to "medium" when none is given.
- Search with grep and glob first, then read the relevant windows of files. Run independent searches in parallel.
- Use bash only for read-only commands (for example git log, git diff, git status, ls, wc). Never run commands that write, install, delete or change state.
- Report findings with file paths and line numbers (\`path:line\`), grouped by topic. Answer the question directly; do not paste large code blocks.`

const PLAN_PROMPT = `You are a read-only software architect. Research the codebase and design an implementation plan. You cannot and must not modify anything.

- Understand the request and the existing patterns first: find similar features, the modules involved and their conventions.
- Use bash only for read-only commands. Never write, install or delete.
- Weigh the realistic options briefly and pick one, with the reason.
- Return a step-by-step plan: ordered steps, each naming the files to change and what changes there; the risks and open questions; how to verify the result.
- End with a "Critical files" list of the 3 to 7 files that matter most, with a one-line reason each.`

const WRITE_TOOLS = [TOOL.edit, TOOL.write, TOOL.delete]
const WEB_TOOLS = [TOOL.webFetch, TOOL.webSearch]

/** The agents every session can spawn; lowest priority on a name collision. */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'general-purpose',
    description:
      'General-purpose agent for complex, multi-step tasks that need both exploration and changes. Has all tools.',
    prompt: GENERAL_PURPOSE_PROMPT,
    source: 'builtin',
  },
  {
    name: 'explore',
    description:
      'Fast read-only agent for searching and analysing the codebase (find files, locate code, answer how/where questions). State the thoroughness: quick, medium or very thorough.',
    prompt: EXPLORE_PROMPT,
    tools: [...READ_ONLY_TOOLS.filter((t) => t !== TOOL.todo), TOOL.bash, ...WEB_TOOLS],
    disallowedTools: [...WRITE_TOOLS, TOOL.agent],
    permissionMode: 'plan',
    source: 'builtin',
  },
  {
    name: 'plan',
    description:
      'Read-only software architect: researches the codebase and returns a step-by-step implementation plan with the critical files.',
    prompt: PLAN_PROMPT,
    tools: [...READ_ONLY_TOOLS.filter((t) => t !== TOOL.todo), TOOL.bash, ...WEB_TOOLS],
    disallowedTools: [...WRITE_TOOLS, TOOL.agent],
    permissionMode: 'plan',
    source: 'builtin',
  },
]
