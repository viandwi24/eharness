import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'filesystem/index': 'src/filesystem/index.ts',
    'filesystem/memory': 'src/filesystem/memory.ts',
    'filesystem/node': 'src/filesystem/node.ts',
    'connectors/index': 'src/connectors/index.ts',
    'storage/memory': 'src/storage/memory.ts',
    'mcp/index': 'src/mcp/index.ts',
    'todos/index': 'src/todos/index.ts',
    'guard/index': 'src/guard/index.ts',
    'openapi/index': 'src/openapi/index.ts',
    'group/index': 'src/group/index.ts',
    'memory/index': 'src/memory/index.ts',
    'activity/index': 'src/activity/index.ts',
    'ask/index': 'src/ask/index.ts',
    'permissions/index': 'src/permissions/index.ts',
    'providers/index': 'src/providers/index.ts',
    'shell/index': 'src/shell/index.ts',
    'subagent/index': 'src/subagent/index.ts',
    'web/index': 'src/web/index.ts',
    'web/node': 'src/web/node.ts',
    'http/index': 'src/http/index.ts',
    'client/index': 'src/client/index.ts',
    'client/react': 'src/client/react.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  // The Node-only entries (ADR-0036: filesystem/node, shell, web/node) import `node:*` on purpose;
  // runtime-neutral modules are kept clean by scripts/check-imports.ts.
  deps: { neverBundle: [/^node:/] },
  dts: true,
  exports: true,
})
