import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'filesystem/index': 'src/filesystem/index.ts',
    'filesystem/memory': 'src/filesystem/memory.ts',
    'filesystem/node': 'src/filesystem/node.ts',
    'storage/memory': 'src/storage/memory.ts',
    'mcp/index': 'src/mcp/index.ts',
    'todos/index': 'src/todos/index.ts',
    'guard/index': 'src/guard/index.ts',
    'openapi/index': 'src/openapi/index.ts',
    'group/index': 'src/group/index.ts',
    'memory/index': 'src/memory/index.ts',
    'ask/index': 'src/ask/index.ts',
    'permissions/index': 'src/permissions/index.ts',
    'shell/index': 'src/shell/index.ts',
    'subagent/index': 'src/subagent/index.ts',
    'web/index': 'src/web/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  exports: true,
})
