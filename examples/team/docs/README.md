# examples/team docs

- [architecture.md](architecture.md) - layers, request flow, eharness wiring, restart guarantees, limits
- [api.md](api.md) - OpenAPI, auth, errors, streaming endpoints and the AI SDK client contract
- [telegram-user-actions.md](telegram-user-actions.md) - the Telegram user account tools: read, send, moderate, manage chats, members and invites, channels, contacts, audit
- [audit.md](audit.md) - the audit of platform actions: what is recorded, the Audit page, CSV export, the `platform_action_log` agent tool
- [events.md](events.md) - the event stream (what each channel adapter delivers, plus app events), the event types each adapter declares, join requests as events, the Events page of a channel and the `events_recent` agent tool
- [tables.md](tables.md) - document tables: schemas, MongoDB-like queries and aggregates, changes with compare-and-set, import and export with the library, limits
- [scripts.md](scripts.md) - scripts: sandboxed TypeScript run by chat events, schedules and table changes; manifest, grants, the `ctx` API, dry runs, approval, gates, examples
- [operations.md](operations.md) - several instances, SQLite vs a networked database, tuning, backups
- [../scripts/README.md](../scripts/README.md) - real-process checks
