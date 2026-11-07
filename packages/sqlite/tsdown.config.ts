import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    bun: 'src/bun.ts',
    node: 'src/node.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  exports: true,
})
