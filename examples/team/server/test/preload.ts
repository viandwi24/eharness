// `debug.invariants` never follows NODE_ENV: switch it on for every agent the tests compose.
process.env.TEAM_DEBUG_INVARIANTS = '1'
// the code sandbox (default: on when python3 exists) is opt-in per test (`config.code`)
process.env.TEAM_CODE_DRIVER ??= 'off'
