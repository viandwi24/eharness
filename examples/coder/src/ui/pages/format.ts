/** Number and time formatting shared by the pages and pickers. */

/** `950`, `1.2k`, `58k`, `140k`, `1.4M`. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) {
    const k = n / 1000
    return `${abs < 9950 ? String(Number(k.toFixed(1))) : String(Math.round(k))}k`
  }
  const m = n / 1_000_000
  return `${abs < 9_950_000 ? String(Number(m.toFixed(1))) : String(Math.round(m))}M`
}

/** `1.6%`, `29%`, `70%`: one decimal below 10, whole numbers above. */
export function fmtPct(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const p = (part / whole) * 100
  if (p > 0 && p < 0.05) return '<0.1%'
  return `${p < 9.95 ? String(Number(p.toFixed(1))) : String(Math.round(p))}%`
}

/** `$0.0123`, `$1.24`. */
export function fmtUsd(n: number): string {
  return `$${n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`
}

/** USD per million tokens, without trailing zeros: `3`, `0.25`, `15`. */
export function fmtPrice(n: number): string {
  return String(Number(n.toFixed(2)))
}

/** `850ms`, `12s`, `3m 05s`, `1h 02m`. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** `just now`, `5m ago`, `2h ago`, `3d ago`. */
export function fmtAgo(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** Model id without its provider prefix: `anthropic/claude-sonnet-4.6` → `claude-sonnet-4.6`. */
export function shortModel(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/** Pad or cut to exactly `width` columns (plain text only). */
export function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)
}
