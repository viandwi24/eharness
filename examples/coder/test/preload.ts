/**
 * Bun test preload (`bunfig.toml`): every agent the app builds runs with `debug.invariants: true`
 * (`CODER_DEBUG_INVARIANTS`, read by `createAgents`), so an invalid saved message or an
 * inconsistent session state fails the test instead of scrolling by as a warning.
 */
process.env.CODER_DEBUG_INVARIANTS = '1'
