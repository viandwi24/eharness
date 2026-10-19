const c = JSON.parse(await Bun.file('config.json').text())
if (c.server.port !== 8080 || c.debug !== false || c.server.host !== '0.0.0.0' || c.name !== 'svc') {
  console.error('config wrong', c)
  process.exit(1)
}
