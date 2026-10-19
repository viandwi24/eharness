/**
 * `bun run compile`: one self-contained binary at `dist/coder` (pass another path as the first
 * argument). `ink` imports its optional dev tool `react-devtools-core` at load time, which is not
 * installed: the plugin below resolves it to an empty module (it is only used with `DEV=true`).
 */
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const outfile = resolve(process.argv[2] ?? 'dist/coder')
await mkdir(dirname(outfile), { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../src/main.tsx')],
  compile: { outfile },
  plugins: [
    {
      name: 'stub-react-devtools-core',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default { initialize() {}, connectToDevTools() {} }',
          loader: 'js',
        }))
      },
    },
  ],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`compiled ${outfile}`)
