import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'filesystem/index': 'src/filesystem/index.ts',
    'filesystem/memory': 'src/filesystem/memory.ts',
    'storage/memory': 'src/storage/memory.ts',
    'mcp/index': 'src/mcp/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  exports: true,
})
