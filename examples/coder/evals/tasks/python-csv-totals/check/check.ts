import { existsSync, readFileSync } from 'node:fs'

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

if (!existsSync('work/report.json')) fail('work/report.json is missing')
let report: Record<string, number>
try {
  report = JSON.parse(readFileSync('work/report.json', 'utf8'))
} catch {
  fail('work/report.json is not valid JSON')
  throw new Error('unreachable')
}
const want: Record<string, number> = { north: 160, south: 100, east: 15.5 }
for (const [region, total] of Object.entries(want)) {
  if (Math.abs(Number(report[region]) - total) > 0.001) {
    fail(`${region}: expected ${total}, got ${report[region]}`)
  }
}
if (Object.keys(report).length !== 3) fail('report must hold exactly the three regions')
if (!readFileSync('work/sales.csv', 'utf8').startsWith('region,amount\nnorth,120\n')) {
  fail('sales.csv was changed')
}
