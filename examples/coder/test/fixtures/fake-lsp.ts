/**
 * Tiny fake language server for tests (run with `bun`). Flags:
 *   --hang-hover            never answer textDocument/hover
 *   --crash-once=<file>     exit(1) on the first hover when <file> does not exist (creates it)
 *   --chunky                write every message in 3-byte pieces, two messages merged when possible
 */
const args = process.argv.slice(2)
const hangHover = args.includes('--hang-hover')
const chunky = args.includes('--chunky')
const crashOnce = args.find((a) => a.startsWith('--crash-once='))?.slice('--crash-once='.length)

function write(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message))
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
  if (chunky) {
    for (let i = 0; i < frame.length; i += 3) process.stdout.write(frame.subarray(i, i + 3))
  } else process.stdout.write(frame)
}

let buffer = Buffer.alloc(0)
let configReplied = false
const texts = new Map<string, string>()

function diagnosticsFor(uri: string, text: string): void {
  const diagnostics = text.split('\n').flatMap((line, i) => {
    const col = line.indexOf('BAD')
    return col === -1
      ? []
      : [
          {
            range: { start: { line: i, character: col }, end: { line: i, character: col + 3 } },
            severity: 1,
            source: 'fake',
            code: 1234,
            message: 'BAD is not allowed',
          },
        ]
  })
  write({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } })
}

function handle(msg: { id?: number; method?: string; params?: any; result?: unknown }): void {
  if (msg.method === undefined) {
    if (msg.id === 9001) configReplied = Array.isArray(msg.result)
    return
  }
  const uri: string | undefined = msg.params?.textDocument?.uri
  switch (msg.method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { capabilities: { definitionProvider: true, hoverProvider: true } },
      })
      return
    case 'initialized':
      write({
        jsonrpc: '2.0',
        id: 9001,
        method: 'workspace/configuration',
        params: { items: [{}, {}] },
      })
      return
    case 'textDocument/didOpen':
      texts.set(msg.params.textDocument.uri, msg.params.textDocument.text)
      diagnosticsFor(msg.params.textDocument.uri, msg.params.textDocument.text)
      return
    case 'textDocument/didChange':
      texts.set(uri as string, msg.params.contentChanges[0].text)
      diagnosticsFor(uri as string, msg.params.contentChanges[0].text)
      return
    case 'textDocument/definition':
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          uri,
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
        },
      })
      return
    case 'textDocument/references':
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: [
          { uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } } },
          { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
        ],
      })
      return
    case 'textDocument/hover':
      if (hangHover) return
      if (crashOnce && !require('node:fs').existsSync(crashOnce)) {
        require('node:fs').writeFileSync(crashOnce, 'x')
        process.exit(1)
      }
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          contents: {
            kind: 'markdown',
            value: `\`\`\`ts\nconst foo: number\n\`\`\`\nconfig-replied=${configReplied} v=${texts.get(uri as string)?.length}`,
          },
        },
      })
      return
    case 'textDocument/documentSymbol':
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: [
          {
            name: 'Foo',
            kind: 5,
            range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
            children: [
              {
                name: 'bar',
                kind: 6,
                range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
                selectionRange: {
                  start: { line: 1, character: 2 },
                  end: { line: 1, character: 5 },
                },
              },
            ],
          },
        ],
      })
      return
    case 'workspace/symbol':
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: [
          {
            name: 'Foo',
            kind: 5,
            containerName: 'mod',
            location: {
              uri: [...texts.keys()][0] ?? 'file:///nowhere.ts',
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
            },
          },
        ],
      })
      return
    case 'shutdown':
      write({ jsonrpc: '2.0', id: msg.id, result: null })
      return
    case 'exit':
      process.exit(0)
      return
    default:
      if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, result: null })
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end === -1) return
    const len = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
    if (buffer.length < end + 4 + len) return
    const body = buffer.subarray(end + 4, end + 4 + len).toString()
    buffer = buffer.subarray(end + 4 + len)
    handle(JSON.parse(body))
  }
})
