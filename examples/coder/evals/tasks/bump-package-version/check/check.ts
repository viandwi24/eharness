const p = JSON.parse(await Bun.file('package.json').text())
if (p.version !== '1.3.0' || p.scripts.lint !== 'echo lint ok' || p.scripts.test !== 'bun test' || p.name !== 'widget') process.exit(1)
