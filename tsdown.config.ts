import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'filesystem/index': 'src/filesystem/index.ts',
    'filesystem/memory': 'src/filesystem/memory.ts',
    'storage/memory': 'src/storage/memory.ts',
    'mcp/index': 'src/mcp/index.ts',
    'todos/index': 'src/todos/index.ts',
    'guard/index': 'src/guard/index.ts',
    'openapi/index': 'src/openapi/index.ts',
    'memory/index': 'src/memory/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  exports: true,
})
