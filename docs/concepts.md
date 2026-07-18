# Key concepts

Sync, persistence, offline queueing, and reconciliation are implemented in the `@laboverwire/stitch-wasm` store. `@laboverwire/stitch` is a thin binding layer that wraps that store — exposing it through `createStore` plus the React and Vue bindings. The concepts below describe how the wasm store behaves; the `StoreConfig` and origin tags you pass through this package drive it.

## Origin tags

Mutations carry an `originTag` controlling propagation:

- `null`/`undefined` — local user mutation, propagated everywhere (memory → persistence → MQTT)
- `'remote'` — from network, skips persistence write (prevents loops)
- `'load'` — from scope loading, skips persistence write
- `'clear'` — scope clearing operation

## Offline queue

Local mutations are queued in `pending_sync` and flushed when connected. `pendingMutationCount(scopeId)` reports how many are outstanding. Before flushing, mutations are consolidated:

- Multiple updates to same entity → merged (last write wins per field)
- Insert + updates → single insert with merged data
- Insert + delete → just delete

## Reconciliation

On reconnect or scope replace, server state is compared with local:

- Server records not found locally → created locally
- Local records not on server → deleted (unless pending insert in queue)
- Records with pending local updates → local version kept

## Connection resilience

- Exponential backoff: `min(1000 * 2^n, 30000)ms` with 25% jitter for 5 attempts, then 15s intervals
- Auth errors cancel reconnection entirely
- Tab visibility: if hidden >30s and disconnected, auto-reconnect triggers on return
