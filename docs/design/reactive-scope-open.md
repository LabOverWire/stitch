# Design: Reactive scope-open for server-backed sync

**Status**: Draft for review. Not implemented.

**Purpose**: Remove the blocking `Promise.all` of N request/reply round-trips inside scope-open by having the server stream per-record events instead of replying to batched `fetchList` queries. The client subscribes once and reacts to whatever arrives — no `Promise.all`, no per-call timeout, no "loaded" gate.

This is a **design proposal** for the existing server-backed sync flow. It is intentionally orthogonal to the peer-mode design in `reactive-peer-mode.md` — they share a target shape (one streaming channel, no client-side deadlines) but address different deployments.

> **Where the work lands (0.5.0 architecture).** As of 0.5.0 the TypeScript store backend has been removed. `@laboverwire/stitch` is a thin, framework-agnostic binding layer: `src/store.ts` is a small adapter that wraps the Rust/WASM `Store` from `@laboverwire/stitch-wasm` (`^0.2.1`). **All store / sync / persistence / offline-queue / MQTT logic now lives inside the wasm**, compiled from the sibling `stitch-rs` repo — not in this package. The files an earlier draft of this doc proposed editing (`src/sync-engine.ts`, `src/remote-sync-layer.ts`, `src/memory-store.ts`, `src/persistence-layer.ts`, `src/offline-queue.ts`) no longer exist here. The **client-side** changes in this design are implemented in `stitch-rs`; this repo's adapter is essentially untouched because `replaceScope` already forwards to the wasm and already returns `Promise<void>`. The **server-side** changes (the load-bearing part) are in MQDB. Line references below point at the wasm/protocol behaviour, not at TypeScript in this package; where a concrete line in this repo is cited it is the thin delegating call, not the logic.

---

## 1. Motivation

### 1.1 What scope-open does today

In this package, `store.replaceScope` (`src/store.ts:245`) is a one-line delegate to the wasm store:

```ts
replaceScope(scopeId: string): Promise<void> {
  return this.#afterReady(() => this.#inner.replaceScope(scopeId));
}
```

There is no `Promise.all`, no buffering, and no reconcile path in this repo — all of that is internal to `@laboverwire/stitch-wasm` and is not observable or editable from here. The description below is the protocol-level behaviour, inferred from the pre-0.5.0 TypeScript implementation (now relocated into `stitch-rs`) and the wire contract. Opening a scope does:

1. Subscribe to `${prefix}/${rootEntity}/${scopeId}/#` (streaming, reactive).
2. Issue N parallel one-shot request/reply round-trips — one `fetchOne` for the root plus one `fetchList` per child entity — each capped by the wasm's per-request timeout.
3. While step 2 is in flight, mutation events arriving on the events topic are buffered inside the wasm instead of being applied immediately.
4. After step 2 resolves, the wasm drains the buffer, reconciles the assembled snapshot into IndexedDB and its in-memory cache, and the `replaceScope` promise resolves.

The user-visible "wait" on `await store.replaceScope(id)` is step 2: the wasm holds the promise until every child entity's list reply has arrived. With slow networks or large scopes this dominates time-to-interactive.

### 1.2 Why this is the wrong shape

Stitch already has a fully reactive subscription path (Pattern A in §2 of `reactive-peer-mode.md`). The events topic streams mutations with no timer, no deadline, callback-per-message. Scope-open *also* uses it, but only for events that occur *during* step 2 — once step 2 resolves, the buffer drains and from then on the subscription is the only path.

There is no good reason for the initial state to come through a different channel from subsequent mutations. The split exists because the server emits a batched reply to `fetchList` instead of a stream of per-record events.

Collapsing both paths onto the events topic produces:

- One channel for both bootstrap and ongoing sync.
- No `Promise.all`, no per-request deadline on scope-open.
- `replaceScope` returns as soon as the subscription is established. UI populates reactively as records stream in.
- Same bootstrap shape as peer mode (§4.2 of `reactive-peer-mode.md`), with the server filling the peer role.

### 1.3 What this design does NOT change

- **Mutations stay request/reply.** Writes need synchronous validation (ownership, constraint violations, server-canonical fields). Removing the await from `create` / `update` / `delete` is a separate, harder design problem and is explicitly out of scope here.
- **The wasm request timeout stays.** It still applies to mutations and to any other request/reply call inside the wasm. This design simply removes scope-open from the set of callers.
- **The events topic structure stays.** Same `${prefix}/${rootEntity}/${scopeId}/events/{type}` topics, same payload shape, same `x-origin-client-id` filter. Only the *bootstrap delivery* changes.

## 2. Wire-level flow

### 2.1 Client publishes a hello

When `replaceScope(scopeId)` is called and the client is connected, the wasm publishes one message to a new topic:

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

1. Validate the requesting client's auth and access to `scopeId` using existing `userScopeField` rules. If denied, publish a single error event on the client's response topic (`${responseTopicPrefix}/{clientId}/scope-open-error`) and stop. The error event carries `{scopeId, code, message}`. (Mechanism mirrors today's 401/403 auth-failure paths in the wasm's remote-sync code.)
2. Diff the requesting client's manifest against server-side state for that scope:
   - For each record the server has that the client lacks, or has at a lower `_version`: publish a synthetic `events/created` (or `events/updated`) event on the scope topic carrying the full record. The `sender` field on these synthetic events is `'__server_replay__'` (a reserved value clients treat as non-self).
   - For each record in the client's manifest that the server has marked deleted: publish a synthetic `events/deleted` event.
   - For each record in the client's manifest that the server's state matches at the same `_version`: emit nothing.
3. Once the diff is fully published, the server is done. There is no "I'm finished" message — the client never asks for one.

The synthetic events are indistinguishable on the wire from real mutation events. They flow through the wasm's remote-mutation handler and into its apply path, where the existing `_version` LWW compare resolves any conflict against locally-pending writes.

### 2.3 Client reacts

After publishing the hello, `replaceScope` returns. The client's events-topic subscription (already established when the scope opened) delivers each replay event as it arrives. Each event is applied via the wasm's normal remote-mutation path — the same code as a live remote mutation.

There is no "scope is loaded" promise resolution. The UI populates as records stream in. Because `subscribeToScope` / `subscribeToEntity` callbacks are delivered **asynchronously** (one tick after each event is applied — see the 0.5.0 behavioural change), the UI reflects each applied record a tick behind the apply, not synchronously. Apps that need a "loaded" gate implement one themselves (e.g., observe the memory snapshot for stability) — same recommendation as peer mode (§6.2 of `reactive-peer-mode.md`).

### 2.4 Concurrent mutations during replay

A peer (or the user themselves on another device) mutates a record while the server is mid-replay. The mutation event flows on the same scope events topic. The client receives both the replay event and the live mutation event in publish order, applies both via the wasm's remote-mutation path, and `_version` LWW resolves any overlap. No special handling needed.

### 2.5 The per-mutation version-bump round-trip goes away

Today every child mutation triggers a *second* request/reply inside the wasm to bump the root entity's version field. In the new flow:

- The server bumps the scope version implicitly when it processes any child mutation.
- The server emits an `events/updated` event for the root entity on the same topic, carrying the new `_version` (and `updatedAt`).
- The client receives that event reactively. No round-trip.

This halves the per-mutation latency and removes a hidden second timeout from every awaited write.

## 3. API surface changes

### 3.1 `StoreConfig`

No new config field, and no reliance on an existing sync-mode selector — `StoreConfig` (`src/types.ts:21-38`) has no such field today. The peer-mode design (`reactive-peer-mode.md` §6.1 / §12) *proposes* introducing a `syncMode` field (`'mqdb'` vs `'peer'`); if that lands, this reactive server-backed flow becomes the behaviour of the `'mqdb'` mode:

- This change replaces the classic MQDB scope-open semantics. Old MQDB servers that don't support hello are handled via capability negotiation (§5).
- The proposed `'peer'` mode is unchanged.

Until `syncMode` exists, this design is simply the new behaviour of the single (MQDB-backed) mode, gated by server capability negotiation.

### 3.2 `replaceScope` semantics

| Before | After |
|---|---|
| Awaits the wasm's batched bootstrap → server returns full state → wasm reconciles + loads → resolve. UI sees complete state on resolve. | Subscribes to events, publishes hello, returns immediately. UI starts with whatever's in local IndexedDB. State populates over time as server replay events arrive (each surfaced a tick later via the async subscription callbacks). |

The public signature is unchanged — `replaceScope(scopeId): Promise<void>` already (`src/types.ts:140`). What changes is *when* the promise resolves and what the app can assume afterward. App code that today does `await store.replaceScope(id); /* assume loaded */` must handle "still populating" UI states. Same trade-off and same guidance as peer mode.

### 3.3 `request()`

Unchanged. Mutations still use it. The per-request timeout still applies to mutations and any other one-shot request/reply — but it lives inside the wasm; in this repo `request()` (`src/store.ts:327`) is a one-line delegate. This design simply removes scope-open (and the per-mutation version-bump, §2.5) from the set of callers.

### 3.4 `fetchList` / `fetchOne`

These are wasm-internal protocol requests, not public API of `@laboverwire/stitch`. Today the wasm uses them to bootstrap a scope. Under this design the wasm stops using them for scope-open. They may remain available inside the wasm for ad-hoc queries that don't want to subscribe (rare today, may be removed entirely if no caller remains).

### 3.5 Return type

The public `Store.replaceScope` already returns `Promise<void>` (`src/types.ts:140`), so nothing in this package's type surface changes. The old TypeScript backend used internal snapshot types (`ScopeState` and friends) to assemble bootstrap state; those were removed from the public API in 0.5.0 and now exist only inside the wasm — there is nothing in `src/types.ts` to reshape for this design. The engine has nothing meaningful to return synchronously; state populates via the normal mutation-apply path.

## 4. What changes, and where

The client-side changes land in `stitch-rs` (compiled into `@laboverwire/stitch-wasm`). The server-side changes land in MQDB. This package's TypeScript adapter is essentially untouched.

### 4.1 Client sync engine (`stitch-rs` / `@laboverwire/stitch-wasm`)

- **Scope-open**: drop the `Promise.all` of `fetchOne` + `fetchList` round-trips. Subscribe to the scope topic, publish a hello message, return. The buffer-around-snapshot machinery becomes unnecessary because there is no longer an "await snapshot" phase to buffer around.
- **Per-mutation version bump**: delete. The server handles version bumping implicitly (§2.5). `create` / `update` / `delete` drop the trailing version-bump request — one round-trip per mutation instead of two.
- **New**: handle a `scope-open-error` response on the response topic so scope-open auth failures still surface (as a rejected `replaceScope` promise or as an emitted store-level error event, depending on the chosen contract — see Q1).
- **Top-level discovery**: apply the same hello-based pattern at the top-level entity discovery topic. Open question — see §5.

Estimated diff: net negative LOC. The subscribe-and-replay path is mostly *removal* of the buffering / `Promise.all` logic.

### 4.2 Client remote-mutation apply (`stitch-rs`)

- **Apply path**: unchanged. Replay events are treated identically to live remote mutations. The `sender === '__server_replay__'` value is not own-mutation, so the existing self-filter already accepts it.
- **Snapshot reconcile**: the batched-snapshot reconcile step — "delete locally records the server doesn't have" — is removed. That job still needs to happen, but it now happens reactively as the client receives `events/deleted` for those records during replay.

### 4.3 TypeScript binding layer (`@laboverwire/stitch`)

Essentially no change. `replaceScope` (`src/store.ts:245`) already delegates to `this.#inner.replaceScope(scopeId)` and already returns `Promise<void>`; the new semantics (resolves once the subscription is established, state streams in afterward) are entirely a property of the wasm implementation behind that delegating call. `src/types.ts` needs no edit — `Store.replaceScope` is already `Promise<void>` and the internal snapshot types are already gone.

The only change that would touch this repo is optional: if the contract for surfacing scope-open auth failures is a store-level error event (§5 Q1), that adds one method to the `Store` interface here plus a one-line forward in the adapter. Otherwise this package is untouched.

### 4.4 Server (MQDB)

This is the load-bearing dependency. The server changes are larger than the client changes; this design only works if the server is willing to make them. §4.4.1 below consolidates the full set of requirements so the MQDB owner has one place to scan rather than reassembling them from §2.2, §5, and §8.

Headline list (full breakdown in §4.4.1):

- Subscribe to `${prefix}/+/+/hello` and implement the manifest diff + replay logic in §2.2.
- Emit per-record events on the scope topic instead of replying to `fetchList` / `fetchOne` requests.
- Emit version-bump events on child mutations (replaces the per-mutation client version-bump round-trip).
- Surface auth failures via `scope-open-error` events on the response topic.
- Retain tombstones for deleted records so deletions can be replayed.
- Advertise protocol version on CONNACK so clients can branch.
- Throttle hello requests per client per scope.

### 4.4.1 Server-side requirements (consolidated)

For a fresh reader: this is the complete server-facing contract. Each item is sourced from elsewhere in the doc; the cross-references identify where the requirement is motivated.

**New protocol handlers**

- [ ] **Subscribe to `${prefix}/+/+/hello`** (per-tenant equivalent acceptable). Source: §2.1.
- [ ] **On hello: validate auth.** Use existing `userScopeField` rules. On failure, publish `{scopeId, code, message}` to `${responseTopicPrefix}/{clientId}/scope-open-error`. Do not publish replay events. Source: §2.2 step 1.
- [ ] **On hello: compute manifest diff.** For each record server-side: if absent from client manifest or at lower `_version`, queue for replay. For each record in client manifest: if server has marked deleted (tombstone) at any version newer than client's, queue a delete-replay. If versions match, emit nothing. Source: §2.2 step 2.
- [ ] **Replay is stateless.** No per-client progress tracking. If the client reconnects mid-replay and republishes hello, the server replays the diff from scratch. Source: §2.4 (implicit; surface explicitly).

**New broadcast behaviors**

- [ ] **Synthetic replay events use real `events/{type}` topics** — not a per-client replay channel. They are indistinguishable on the wire from live mutation events, so existing subscribers see them too and apply them via LWW (idempotent — `_version` matches → no-op). The fan-out cost to existing peers is accepted as the price of keeping a single channel. Source: §2.2 step 2 (implicit).
- [ ] **Synthetic events carry `sender: '__server_replay__'`** as an MQTT user property (and/or payload field, matching the existing `sender` shape). This reserved value is not "own mutation" for any client, so all clients receive and apply it. The server is responsible for setting it. Source: §2.2 step 2 + §4.2.
- [ ] **Emit version-bump events on child mutations.** When the server processes a child create / update / delete, it bumps the root's `_version` (and `updatedAt`) and publishes an `events/updated` for the root entity carrying the new version. Replaces the client-driven version-bump round-trip. Source: §2.5.
- [ ] **Emit per-record events instead of (or in addition to) batched `fetchList` / `fetchOne` replies.** During the deprecation window (§8 Phase 4), both paths can coexist behind capability negotiation. After the window, `fetchList` / `fetchOne` handlers are removed. Source: §3.4 + §8.

**New persistence requirements**

- [ ] **Tombstone tracking for deleted records.** The server must retain *some* record of deletions (e.g., a `_deleted_at` column with rows kept indefinitely, or a tombstone table) so it can publish `events/deleted` to a client whose manifest still lists a record the server has since removed. If MQDB today does hard deletes, this is a new schema requirement. Tombstone retention policy (forever vs TTL) is open — see Q2 of `reactive-peer-mode.md` §8 for the same trade-off; same recommendation (TTL with documented offline-window limit). Source: §2.2 step 2.

**New connection-time advertisement**

- [ ] **Capability advertisement on CONNACK** via MQTT 5 User Property: e.g. `stitch-protocol-version: 2`. Clients that do not see this property fall back to the legacy `fetchList` flow. This makes incremental rollout possible without a hard cutover. Source: §5/Q2.

**New operational concerns**

- [ ] **Hello rate limiting** per client per scope. A misbehaving or malicious client publishing hello in a tight loop triggers replay every time, multiplied by the fan-out to all current subscribers. Suggested floor: at most one replay per client per scope per N seconds (N to be tuned; start at 5–10 s). Server should silently drop or NACK hellos beyond the limit. Source: this section (not previously called out — gap closed here).

**Deprecation track**

- [ ] **Phase 4 deletes legacy handlers.** Once capability negotiation has been live for one major version and telemetry confirms no clients are falling back, the server's `fetchList`, `fetchOne`, and (once the client version-bump is removed) the version-bump request handlers can be deleted. Source: §8 Phase 4–5.

**Out of scope for v1**

- [ ] **Top-level entity discovery via hello.** Same shape as the per-scope hello but on the discovery topic — server replays the user's accessible scopes. Deferred to a follow-up; v1 keeps `fetchList(rootEntity)` for top-level discovery even after per-scope `replaceScope` goes reactive. Source: §5/Q3.

## 5. Open questions

### Q1: Auth failure surfacing

Today scope-open rejects with the server's 401/403 reply. In the reactive flow, `replaceScope` has already returned by the time the server validates the hello.

Options:

- **Reject `replaceScope` only on transport errors; surface auth failures via a store-level event** (e.g. `store.onScopeError(cb)`). Apps that care register a listener. This is the one change that would touch the TS adapter (§4.3).
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

Recommendation: same hello mechanism at the discovery topic. Client publishes a discovery hello with whatever roots it already has locally; server replays the delta. Out-of-scope details mirror the top-level-entity discussion in `reactive-peer-mode.md`.

### Q4: Replay ordering

The server publishes replay events in some order. If a child references a root that hasn't replayed yet, the client may briefly see a child without its root in the memory cache.

Options:

- **Server publishes root first, then children** — natural ordering. Documented contract.
- **Client tolerates out-of-order** — already partially true (the mutation handler doesn't enforce parent-before-child). Document as "same guarantees as live mutations: eventual consistency, brief inconsistency tolerated."

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
- **Strong consistency on scope-open.** The reactive flow is eventually consistent. Apps requiring "see all data before render" need an app-level loaded-gate (observe the memory snapshot for stability). Note that subscription callbacks are async (one tick behind each applied event), so any such gate must poll/observe rather than assume synchronous delivery.

## 7. Estimated scope

Rough LOC budget. The concrete, line-level budget belongs to the `stitch-rs` repo, not this package; the numbers below are indicative.

| Component | Net change |
|---|---|
| `stitch-rs` scope-open / sync module | −250 (remove `Promise.all` + buffering + client version-bump) |
| `stitch-rs` reconcile path | −100 (remove batched-snapshot reconcile) |
| `@laboverwire/stitch` TS adapter (`src/store.ts`) | ~0 — `replaceScope` already delegates and returns `Promise<void>` |
| `@laboverwire/stitch` types (`src/types.ts`) | 0 — `Store.replaceScope` already `Promise<void>`; internal snapshot types already removed in 0.5.0 |
| Tests (`stitch-rs` unit + this repo's browser suite) | +400 (new replay tests, capability fallback tests) |

Net: roughly LOC-neutral but structurally simpler. Almost all of it is in `stitch-rs`.

Server-side scope is **not estimated here** — depends on MQDB's existing architecture and whoever owns it. This document captures only the protocol contract.

## 8. Implementation phasing

1. **Phase 0**: this doc + agreement with MQDB owner on protocol.
2. **Phase 1**: server implements hello handling and per-record replay events behind a feature flag. Existing `fetchList` path stays in parallel.
3. **Phase 2**: capability negotiation. The wasm detects support and routes scope-open through the new path when available.
4. **Phase 3**: the client-side per-mutation version-bump is deleted from the wasm; server handles version bump implicitly.
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

Once both ship, the events-topic stream is identical from the client's perspective in both modes. The proposed `syncMode` flag (`reactive-peer-mode.md` §12) would control only the source-of-truth and versioning concerns spelled out there.

This is the practical argument for sequencing: ship reactive scope-open first, then peer mode reuses the streaming infrastructure with only the source-of-truth and versioning differences to design.
