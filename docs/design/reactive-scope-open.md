# Design: Reactive scope-open for server-backed sync

**Status**: Draft for review. Not implemented.

**Purpose**: Remove the blocking `Promise.all` of N request/reply round-trips inside `replaceScope` by having the server stream per-record events instead of replying to batched `fetchList` queries. The client subscribes once and reacts to whatever arrives — no `Promise.all`, no per-call timeout, no "loaded" gate.

This is a **design proposal** for the existing server-backed sync flow. It is intentionally orthogonal to the peer-mode design in `reactive-peer-mode.md` — they share a target shape (one streaming channel, no client-side deadlines) but address different deployments.

---

## 1. Motivation

### 1.1 What `replaceScope` does today

`store.replaceScope` (`store.ts:484`) → `sync.openScope` (`sync-engine.ts:563`) does:

1. Subscribe to `${prefix}/${rootEntity}/${scopeId}/#` (streaming, reactive).
2. `await Promise.all([fetchOne(rootEntity, scopeId), ...childEntities.map(e => fetchList(e, scopeId))])` — N parallel one-shot request/reply round-trips, each capped at 10 s by the timeout in `request()` (`sync-engine.ts:752`).
3. While step 2 is in flight, mutation events arriving on the events topic are buffered in `this.buffered` (line 552) instead of being applied immediately.
4. After step 2 resolves, `openScope` drains the buffer, returns the assembled `ScopeState`, and `replaceScope` reconciles it into IndexedDB + MemoryStore.

The user-visible "wait" on `await store.replaceScope(id)` is step 2: stitch holds the promise until every child entity's list reply has arrived. With slow networks or large scopes this dominates time-to-interactive.

### 1.2 Why this is the wrong shape

Stitch already has a fully reactive subscription path (Pattern A in §2 of `reactive-peer-mode.md`). The events topic streams mutations with no timer, no deadline, callback-per-message. `openScope` *also* uses it, but only for events that occur *during* step 2 — once step 2 resolves, the buffer drains and from then on the subscription is the only path.

There is no good reason for the initial state to come through a different channel from subsequent mutations. The split exists because the server emits a batched reply to `fetchList` instead of a stream of per-record events.

Collapsing both paths onto the events topic produces:

- One channel for both bootstrap and ongoing sync.
- No `Promise.all`, no 10 s deadline on scope-open.
- `replaceScope` returns as soon as the subscription is established. UI populates reactively as records stream in.
- Same bootstrap shape as peer mode (§4.2 of `reactive-peer-mode.md`), with the server filling the peer role.

### 1.3 What this design does NOT change

- **Mutations stay request/reply.** Writes need synchronous validation (ownership, constraint violations, server-canonical fields). Removing the await from `createEntity` / `updateEntity` / `deleteEntity` is a separate, harder design problem and is explicitly out of scope here.
- **The 10 s `request()` timeout stays.** It still applies to mutations and to any other request/reply call. This design simply removes scope-open from the set of callers.
- **The events topic structure stays.** Same `${prefix}/${rootEntity}/${scopeId}/events/{type}` topics, same payload shape, same `x-origin-client-id` filter. Only the *bootstrap delivery* changes.

## 2. Wire-level flow

### 2.1 Client publishes a hello

When `replaceScope(scopeId)` is called and the client is connected, stitch publishes one message to a new topic:

```
${prefix}/${rootEntity}/${scopeId}/hello
```

Payload:

```json
{
  "clientId": "<stitch-client-id>",
  "manifest": [
    { "id": "<entity-id>", "version": <number> },
    ...
  ]
}
```

The manifest is the union of root + children currently in local IndexedDB for `scopeId`. For a fresh device, the manifest is `[]`.

QoS 1, `retain=false`. No response topic, no correlation data — this is fire-and-forget from the client's perspective.

### 2.2 Server reacts

The server (MQDB or any compatible backend) subscribes to `${prefix}/+/+/hello` (or its tenant-scoped equivalent). On receiving a hello:

1. Validate the requesting client's auth and access to `scopeId` using existing `userScopeField` rules. If denied, publish a single error event on the client's response topic (`${responsePrefix}/${clientId}/scope-open-error`) and stop. The error event carries `{scopeId, code, message}`. (Mechanism mirrors today's 401/403 paths in `checkResponseAndAuth` at `sync-engine.ts:628`.)
2. Diff the requesting client's manifest against server-side state for that scope:
   - For each record the server has that the client lacks, or has at a lower `_version`: publish a synthetic `events/created` (or `events/updated`) event on the scope topic carrying the full record. The `sender` field on these synthetic events is `'__server_replay__'` (a reserved value clients treat as non-self).
   - For each record in the client's manifest that the server has marked deleted: publish a synthetic `events/deleted` event.
   - For each record in the client's manifest that the server's state matches at the same `_version`: emit nothing.
3. Once the diff is fully published, the server is done. There is no "I'm finished" message — the client never asks for one.

The synthetic events are indistinguishable on the wire from real mutation events. They flow through `handleWatchMessage` (`sync-engine.ts:447`) and into `applyMutationToDb`, where the existing `_version` LWW compare resolves any conflict against locally-pending writes.

### 2.3 Client reacts

After publishing the hello, `replaceScope` returns. The client's events-topic subscription (already established in step 1 of `openScope`) delivers each replay event as it arrives. Each event is applied via the existing `applyMutationToDb` path — same code as a normal remote mutation.

There is no "scope is loaded" promise resolution. The UI populates as records stream in. Apps that need a "loaded" gate implement one themselves (e.g., observe MemoryStore for stability) — same recommendation as peer mode (§6.2 of `reactive-peer-mode.md`).

### 2.4 Concurrent mutations during replay

A peer (or the user themselves on another device) mutates a record while the server is mid-replay. The mutation event flows on the same scope events topic. The client receives both the replay event and the live mutation event in publish order, applies both via `applyMutationToDb`, and `_version` LWW resolves any overlap. No special handling needed.

### 2.5 `bumpScopeVersion` goes away

Today every child mutation triggers a *second* request/reply (`sync-engine.ts:668, 685, 695`) to bump the root entity's version field. In the new flow:

- The server bumps the scope version implicitly when it processes any child mutation.
- The server emits an `events/updated` event for the root entity on the same topic, carrying the new `_version` (and `updatedAt`).
- The client receives that event reactively. No round-trip.

This halves the per-mutation latency and removes a hidden second 10 s timeout from every awaited write.

## 3. API surface changes

### 3.1 `StoreConfig`

No new config field. The existing `syncMode` field from peer mode could in principle gain a `'mqdb-reactive'` value, but a cleaner cut is:

- This change replaces `syncMode: 'mqdb'` semantics. Old MQDB servers that don't support hello are handled via capability negotiation (§5).
- `syncMode: 'peer'` is unchanged.

### 3.2 `replaceScope` semantics

| Before | After |
|---|---|
| Awaits `openScope` → server returns full ScopeState → reconcile + load → resolve. UI sees complete state on resolve. | Subscribes to events, publishes hello, returns immediately. UI starts with whatever's in local IndexedDB. State populates over time as server replay events arrive. |

This is a deliberate API contract change. App code that today does `await store.replaceScope(id); /* assume loaded */` must handle "still populating" UI states. Same trade-off and same guidance as peer mode.

### 3.3 `request()`

Unchanged. Mutations still use it. The 10 s timeout still applies to mutations, `bumpScopeVersion` (now unused — see §2.5), and any other one-shot request/reply.

### 3.4 `fetchList` / `fetchOne`

No longer called by `openScope`. They remain available for ad-hoc queries that don't want to subscribe (rare today, may be removed entirely if no caller remains).

### 3.5 `OpenScopeResult`

`openScope` returns immediately. The current `ScopeState` shape (`root`, `children`, `version`, `bufferedMutations`) is replaced by `Promise<void>` — the engine has nothing meaningful to return synchronously. State populates via the existing mutation handler.

## 4. What changes in the existing code

### 4.1 `src/sync-engine.ts`

- `openScope`: drop the `Promise.all` block (lines 576–589). Subscribe to the scope topic, publish a hello message, return. The `awaitingState` / `buffered` machinery (lines 568–570, 595–610) becomes unnecessary because there is no longer an "await snapshot" phase to buffer around.
- `bumpScopeVersion`: delete. The server handles version bumping implicitly.
- `createEntity` / `updateEntity` / `deleteEntity`: drop the trailing `await this.bumpScopeVersion(scopeId)` call (lines 668, 685, 695). One round-trip per mutation instead of two.
- New: handle a `scope-open-error` response on the response topic so that scope-open auth failures still surface as a rejected promise on `replaceScope` (or as an emitted error event on the store, depending on the chosen contract — see Q1).
- `subscribeToTopLevel`: same hello-based pattern applied at the top-level entity discovery topic (`${prefix}/${rootEntity}/+/hello` for the server's perspective, `${prefix}/${rootEntity}/discovery/hello` or similar for the client). Open question — see §5.

Estimated diff: net negative LOC. The subscribe-and-replay path is mostly *removal* of the buffering / Promise.all logic.

### 4.2 `src/remote-sync-layer.ts`

- `openScope` callers: no longer receive a fully-populated `ScopeState`. Reconciliation work currently in `replaceScope` (lines 504–545) — `reconcileChildren`, the `bufferedMutations` drain — moves into the streaming path. Each replay event flows through `applyMutationToDb` like any other remote mutation.
- `applyMutationToDb`: unchanged. Treats replay events identically to live mutations. The `sender === '__server_replay__'` value is not own-mutation; the existing filter at `isOwnMutation` (sync-engine.ts:417) already accepts it.
- `reconcileChildren`: only meaningful in the old batched-snapshot flow. Likely deletable. The same job — "delete locally records the server doesn't have" — still needs to happen, but it now happens reactively as the client receives `events/deleted` for those records during replay.

### 4.3 `src/store.ts`

- `replaceScope` (line 484): the long path from line 502 onward (snapshot reconciliation, `loadScopeFromPersistence`, `loadRootIntoMemory`) collapses to: ensure subscription is established, ensure local IndexedDB state is loaded into MemoryStore, return. State updates flow through the existing mutation handler.
- The `setSuppressNotifications(true)` block (line 499) becomes unnecessary — there is no longer a batched-load-then-notify cycle to suppress around.

### 4.4 Server (MQDB)

This is the load-bearing dependency. The server changes are larger than the client changes; this design only works if the server is willing to make them. §4.4.1 below consolidates the full set of requirements so the MQDB owner has one place to scan rather than reassembling them from §2.2, §5, and §8.

Headline list (full breakdown in §4.4.1):

- Subscribe to `${prefix}/+/+/hello` and implement the manifest diff + replay logic in §2.2.
- Emit per-record events on the scope topic instead of replying to `fetchList` / `fetchOne` requests.
- Emit version-bump events on child mutations (replaces the per-mutation client `bumpScopeVersion` round-trip).
- Surface auth failures via `scope-open-error` events on the response topic.
- Retain tombstones for deleted records so deletions can be replayed.
- Advertise protocol version on CONNACK so clients can branch.
- Throttle hello requests per client per scope.

### 4.4.1 Server-side requirements (consolidated)

For a fresh reader: this is the complete server-facing contract. Each item is sourced from elsewhere in the doc; the cross-references identify where the requirement is motivated.

**New protocol handlers**

- [ ] **Subscribe to `${prefix}/+/+/hello`** (per-tenant equivalent acceptable). Source: §2.1.
- [ ] **On hello: validate auth.** Use existing `userScopeField` rules. On failure, publish `{scopeId, code, message}` to `${responsePrefix}/${clientId}/scope-open-error`. Do not publish replay events. Source: §2.2 step 1.
- [ ] **On hello: compute manifest diff.** For each record server-side: if absent from client manifest or at lower `_version`, queue for replay. For each record in client manifest: if server has marked deleted (tombstone) at any version newer than client's, queue a delete-replay. If versions match, emit nothing. Source: §2.2 step 2.
- [ ] **Replay is stateless.** No per-client progress tracking. If the client reconnects mid-replay and republishes hello, the server replays the diff from scratch. Source: §2.4 (implicit; surface explicitly).

**New broadcast behaviors**

- [ ] **Synthetic replay events use real `events/{type}` topics** — not a per-client replay channel. They are indistinguishable on the wire from live mutation events, so existing subscribers see them too and apply them via LWW (idempotent — `_version` matches → no-op). The fan-out cost to existing peers is accepted as the price of keeping a single channel. Source: §2.2 step 2 (implicit).
- [ ] **Synthetic events carry `sender: '__server_replay__'`** as an MQTT user property (and/or payload field, matching the existing `sender` shape). This reserved value is not "own mutation" for any client, so all clients receive and apply it. The server is responsible for setting it. Source: §2.2 step 2 + §4.2.
- [ ] **Emit version-bump events on child mutations.** When the server processes a child create / update / delete, it bumps the root's `_version` (and `updatedAt`) and publishes an `events/updated` for the root entity carrying the new version. Replaces the client-driven `bumpScopeVersion` round-trip. Source: §2.5.
- [ ] **Emit per-record events instead of (or in addition to) batched `fetchList` / `fetchOne` replies.** During the deprecation window (§8 Phase 4), both paths can coexist behind capability negotiation. After the window, `fetchList` / `fetchOne` handlers are removed. Source: §3.4 + §8.

**New persistence requirements**

- [ ] **Tombstone tracking for deleted records.** The server must retain *some* record of deletions (e.g., a `_deleted_at` column with rows kept indefinitely, or a tombstone table) so it can publish `events/deleted` to a client whose manifest still lists a record the server has since removed. If MQDB today does hard deletes, this is a new schema requirement. Tombstone retention policy (forever vs TTL) is open — see Q2 of `reactive-peer-mode.md` §8 for the same trade-off; same recommendation (TTL with documented offline-window limit). Source: §2.2 step 2.

**New connection-time advertisement**

- [ ] **Capability advertisement on CONNACK** via MQTT 5 User Property: e.g. `stitch-protocol-version: 2`. Clients that do not see this property fall back to the legacy `fetchList` flow. This makes incremental rollout possible without a hard cutover. Source: §5/Q2.

**New operational concerns**

- [ ] **Hello rate limiting** per client per scope. A misbehaving or malicious client publishing hello in a tight loop triggers replay every time, multiplied by the fan-out to all current subscribers. Suggested floor: at most one replay per client per scope per N seconds (N to be tuned; start at 5–10 s). Server should silently drop or NACK hellos beyond the limit. Source: this section (not previously called out — gap closed here).

**Deprecation track**

- [ ] **Phase 4 deletes legacy handlers.** Once capability negotiation has been live for one major version and telemetry confirms no clients are falling back, the server's `fetchList`, `fetchOne`, and (once `bumpScopeVersion` is removed client-side) the `bumpScopeVersion` request handlers can be deleted. Source: §8 Phase 4–5.

**Out of scope for v1**

- [ ] **Top-level entity discovery via hello.** Same shape as the per-scope hello but on the discovery topic — server replays the user's accessible scopes. Deferred to a follow-up; v1 keeps `fetchList(rootEntity)` for top-level discovery even after per-scope `replaceScope` goes reactive. Source: §5/Q3.

## 5. Open questions

### Q1: Auth failure surfacing

Today `openScope` rejects with the server's 401/403 reply. In the reactive flow, `replaceScope` has already returned by the time the server validates the hello.

Options:

- **Reject `replaceScope` only on transport errors; surface auth failures via a store-level event** (e.g. `store.onScopeError(cb)`). Apps that care register a listener.
- **Hold `replaceScope`'s promise open until either the first replay event or an error arrives, with a short timeout** — sneaks a timer back in. Reject.
- **Pre-validate auth at connect time** — server publishes a list of accessible scopes on a per-client topic at session start; `replaceScope` rejects synchronously if `scopeId` is not in that list. Adds a connect-time round-trip but no per-scope-open round-trip.

Recommendation: store-level event. Matches the reactive philosophy (no synthetic "loaded" gate, no synthetic "load failed" gate).

### Q2: Backwards compatibility with old MQDB servers

A client running new stitch against an old MQDB server that doesn't subscribe to hello will receive no replay events. Scope appears empty.

Options:

- **Capability negotiation via MQTT 5 User Property on CONNECT.** Server advertises `stitch-protocol-version: 2` (or similar). Client falls back to the old `fetchList` flow if absent.
- **Hard cutover.** Bump stitch's required server version. Document the dependency.
- **Probe-and-fallback.** Client publishes hello with a timeout; if no events arrive in N ms, falls back to `fetchList`. Reintroduces the timer this design is trying to remove.

Recommendation: capability negotiation. The fallback path keeps the old code intact for one major version, then deletes it.

### Q3: Top-level entity discovery

`syncRootEntityList` today iterates all root entities a user can access via `fetchList(rootEntity)` with `userScopeField` filtering on the server. Same problem at this level.

Recommendation: same hello mechanism at the discovery topic. Client publishes a discovery hello with whatever roots it already has locally; server replays the delta. Out-of-scope details mirror peer mode's §10 (top-level entities).

### Q4: Replay ordering

The server publishes replay events in some order. If a child references a root that hasn't replayed yet, the client may briefly see a child without its root in MemoryStore.

Options:

- **Server publishes root first, then children** — natural ordering. Documented contract.
- **Client tolerates out-of-order** — already partially true (the existing mutation handler doesn't enforce parent-before-child). Document as "same guarantees as live mutations: eventual consistency, brief inconsistency tolerated."

Recommendation: document the second. Mirrors normal mutation behavior; no special handling.

### Q5: Replay flooding for large scopes

A scope with 10,000 records produces 10,000 replay messages. At small message size this is tens of MB and seconds of broker fan-out.

Options:

- **Batched replay events** — one message containing N records. Adds a wire-format variant.
- **Manifest diffing reduces volume** — clients with mostly-up-to-date local state only get the delta. Already in the design.
- **Accept it for v1** — document the limit; revisit if real deployments hit it.

Recommendation: accept for v1. The manifest diff keeps the common case (returning user) cheap. Cold start of a 10k-record scope is a real cost but bounded.

## 6. What this design does NOT solve

- **Reactive mutations.** Writes still use request/reply. Surfacing write validation results without an await is a separate, harder problem.
- **Offline scope-open.** If the client is disconnected, `replaceScope` falls back to whatever's in local IndexedDB. Same as today. Reconnect republishes the hello.
- **Cross-scope queries.** Same as today; out of scope.
- **Strong consistency on scope-open.** The reactive flow is eventually consistent. Apps requiring "see all data before render" need an app-level loaded-gate (observe MemoryStore for stability).

## 7. Estimated scope

Rough LOC budget for the client-side change:

| File | Net change |
|---|---|
| `src/sync-engine.ts` | -150 (remove Promise.all + buffering + bumpScopeVersion) |
| `src/remote-sync-layer.ts` | -100 (remove reconcileChildren snapshot path) |
| `src/store.ts` | -60 (collapse replaceScope reconcile path) |
| `src/types.ts` | ±10 (ScopeState removal, OpenScopeResult shape) |
| Tests | +400 (new replay tests, capability fallback tests) |

Net: roughly LOC-neutral but structurally simpler.

Server-side scope is **not estimated here** — depends on MQDB's existing architecture and whoever owns it. This document captures only the protocol contract.

## 8. Implementation phasing

1. **Phase 0**: this doc + agreement with MQDB owner on protocol.
2. **Phase 1**: server implements hello handling and per-record replay events behind a feature flag. Existing `fetchList` path stays in parallel.
3. **Phase 2**: capability negotiation. Stitch detects support and routes scope-open through the new path when available.
4. **Phase 3**: `bumpScopeVersion` deleted from stitch; server handles version bump implicitly.
5. **Phase 4**: deprecation window for old `fetchList`-based scope-open. Eventually removed.
6. **Phase 5**: top-level entity discovery moved to same hello pattern (§ Q3).

Each phase is independently shippable behind capability negotiation.

## 9. Relationship to peer mode

The two designs converge on the same client shape:

- One topic per scope (`events/#`).
- Per-record events for both bootstrap and live updates.
- Hello-driven manifest diff for bootstrap.
- No client-side deadlines.

The differences are entirely upstream of the events topic:

| | This design | Peer mode |
|---|---|---|
| Source of truth | Server | Distributed (each peer's IndexedDB) |
| Versioning | `_version: number` (server-managed) | `_hlc: { ts, counter, nodeId }` (client-managed) |
| Auth validation | Server-side at hello + per-mutation reply | None (each peer trusts its own state) |
| Mutation channel | Request/reply (this design preserves it) | Fire-and-forget events |

Once both ship, the events-topic stream is identical from the client's perspective in both modes. The mode flag (`syncMode`) controls only the source-of-truth and versioning concerns spelled out in §12 of `reactive-peer-mode.md`.

This is the practical argument for sequencing: ship reactive scope-open first, then peer mode reuses the streaming infrastructure with only the source-of-truth and versioning differences to design.
