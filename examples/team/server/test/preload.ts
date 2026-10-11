// `debug.invariants` never follows NODE_ENV: switch it on for every agent the tests compose.
process.env.TEAM_DEBUG_INVARIANTS = '1'
