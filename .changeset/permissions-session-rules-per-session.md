---
"eharness": patch
---

Fix `permissions` rules added with `scope: 'session'` applying to every session that shares the engine. `allow`, `addRule` and `removeRule` take `{ session }`, the plugin decides with `ctx.session.id`, and a session rule applies only to its session. A session rule without an id keeps the engine-wide behavior and warns `W_PERMISSION_SESSION_RULE_GLOBAL` once per engine.
