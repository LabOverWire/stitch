# Design: Reactive peer-coordinated sync mode

**Status**: Draft for review. Not implemented.

**Purpose**: Enable stitch to sync state across clients using a plain MQTT broker — no MQDB backend, no server-side database. Clients coordinate among themselves through pub/sub.

This document is a **design proposal** to be reviewed and corrected before implementation. Open questions are flagged inline.

---

## 1. Motivation

Stitch today depends on MQDB as a central coordinator: clients publish CRUD requests on `$DB/{entity}/...` topics and MQDB replies on a per-client response topic. MQDB is the source of truth; clients are caches.

For stitch to be adoptable without committing the user to MQDB, the library needs a mode where:

- The MQTT broker is just a message bus (any MQTT 5 broker works).
- Clients each persist their own state (already true via `PersistenceLayer` / IndexedDB).
- Clients coordinate among themselves to converge on a shared view of the data.

The primary use case is **single-user, multi-device sync** (one user editing on phone + laptop + tablet). Multi-user collaboration on shared data has the same coordination shape, just with more concurrent writers.

## 2. Why "fully reactive"

Earlier drafts proposed a snapshot/request/wait pattern: a new client publishes a "give me state" request, peers reply on a response topic, the client waits ~1s and merges the highest-HLC reply. Every iteration of this design smuggled in a timer (`settleMs`, response collection window, mutation request timeout).

The correction: **if there is no question, there is no deadline.** Modeling bootstrap as request/response forces a wait window. Modeling everything as one-way event flow eliminates it.

Reactive design principles for this mode:

1. There is one channel — the events topic. Mutations, bootstrap state, deletions all flow through it.
2. No `responseTopic`, no `correlationData`, no per-request waits.
3. `replaceScope` returns immediately. UI reactively reflects MemoryStore as state arrives.
4. The success signal for an outgoing mutation is the broker's PUBACK. There is no application-level acknowledgment.
5. There is no "scope is fully loaded" moment. The system is always converging.

## 3. Topic layout

Two topics, both under the existing `$DB` prefix (configurable as `syncTopicPrefix` today):

```
$DB/{root}/{scope}/events/{type}                 # root mutations
$DB/{root}/{scope}/{child}/events/{type}         # child mutations
$DB/{root}/{scope}/hello                         # presence announcements (new)
```

Where `{type}` is `created` | `updated` | `deleted`.

No response topics. No request topics. No retained messages.

The existing `$DB/clients/{clientId}/{requestId}` inbox (used by MQDB-mode `request()`) is unused in this mode. The `request()` API throws `not supported in peer mode`.

## 4. Wire-level message flows

### 4.1 Mutation (create / update / delete)

Client publishes to the events topic at QoS 1 with `retain=false`:

```json
{
  "operation": "Create",
  "entity": "task",
  "id": "<uuid>",
  "data": { /* full record, including hlc */ },
  "hlc": { "ts": 1714694400000, "counter": 0, "nodeId": "<clientId>" },
  "sender": "<clientId>"
}
```

Broker fans out to all subscribers (peers and the publisher itself; publisher filters its own via the existing `x-origin-client-id` user property check at `sync-engine.ts:519-523`).

**No await on a response.** The publish promise resolves on PUBACK; that is the success signal. The offline queue (`src/offline-queue.ts`) handles broker disconnection.

Compare to today's `createEntity` (sync-engine.ts:654-672) which sets a `responseTopic` and awaits a JSON `{status, code, data}` reply with a 10s timeout. That whole shape is gone.

### 4.2 Bootstrap (new client opens scope)

```
Client A (new)                                Peers B, C (online with state)
───────────────────────────────────────────────────────────────────────────
1. Subscribe to events/#
2. Publish hello {clientId, manifest: [{id, hlc}, ...]}
                                              3. Receive hello, diff manifest
                                              4. For each entity Peer has but
                                                 client lacks (or has older):
                                                 publish events/updated with
                                                 full record
                                              5. For each entity in client's
                                                 manifest that Peer thinks is
                                                 deleted (Peer holds tombstone
                                                 with newer hlc): publish
                                                 events/deleted
6. Receive events on events/#
   (already subscribed in step 1)
7. Apply each via existing
   applyMutationToDb (LWW by hlc)
8. UI re-renders reactively as
   each entity arrives
```

There is no "I'm done" moment for the new client. It just keeps reacting to events. The UI populates as messages flow in over the next tens to hundreds of milliseconds (or longer for large scopes).

The `manifest` is `Array<{id, hlc}>` — what the new client already has from local IndexedDB. Peers diff this against their own state and only emit deltas. For an empty client (first-ever boot), the manifest is `[]` and peers send everything.

### 4.3 Catch-up after offline

Identical to bootstrap. On reconnect, client publishes a fresh `hello` with its current manifest. Peers reactively send the delta. No special offline-detection path needed.

The existing `OfflineQueue` flush already handles outgoing-mutations-during-offline correctly; this design touches only the inbound side.

### 4.4 Deletes

Two modes of delete:

**Locally-initiated**: client publishes `events/deleted` with `{operation: "Delete", entity, id, hlc}`. Peers apply via existing `applyMutationToDb` delete branch.

**Tombstone replay** (during bootstrap): when a peer responds to `hello` and detects an entity in the new client's manifest that the peer no longer has, the peer needs to know whether the entity was deleted (vs. simply never existed). This requires the peer to retain a tombstone.

**Tombstone storage** (open question — see §9): each client persists tombstones in a local table (e.g. `_tombstones` keyed by `{entity, id, hlc}`) for some retention period. Old tombstones are pruned. PersistenceLayer would need a tombstone API.

**Resurrection failure mode**: if every peer prunes a tombstone (TTL expires) while at least one peer still has the deleted entity in its local IndexedDB — most likely because that peer was offline at the time of the original delete and longer than the TTL — bootstrap will replay the entity to anyone whose manifest lacks it. The delete effectively un-happens. This is the central correctness cost of bounded tombstone retention; any TTL chosen in §9/Q2 must be large enough to cover the longest expected offline window, or the system must accept rare resurrections. There is no in-protocol fix without unbounded tombstones or a coordinator.

## 5. Hybrid Logical Clocks (HLC)

### 5.1 Why HLC

LWW with wall-clock `Date.now()` is broken under clock skew: a device with a fast clock dominates writes from devices with slow clocks. Vector clocks are correct but verbose (one entry per node, grows unbounded). HLC is the middle ground:

```ts
type HLC = {
  ts: number;       // wall-clock ms
  counter: number;  // tiebreaker for same-ts events
  nodeId: string;   // tiebreaker for same {ts, counter}
};
```

Compare lexicographically: `(ts, counter, nodeId)`. HLC respects causality: if mutation A causally precedes B (A was observed before B was generated), then `hlc(A) < hlc(B)` regardless of clock skew.

### 5.2 HLC algorithm

On local mutation:
```
local.ts = max(local.ts, wallNow)
local.counter = (local.ts === wallNow) ? local.counter + 1 : 0
emit { ts: local.ts, counter: local.counter, nodeId }
```

On receiving remote mutation with HLC `r`:
```
local.ts = max(local.ts, r.ts, wallNow)
if (local.ts === r.ts)
  local.counter = max(local.counter, r.counter) + 1
else if (local.ts === wallNow)
  local.counter += 1
else
  local.counter = 0
```

(Standard HLC update rule. ~30 LOC. Re-derive from Kulkarni et al. before implementing — the branch structure must agree with the paper.)

### 5.3 Replacing `_version`

Today, `applyMutationToDb` (remote-sync-layer.ts:386-399) compares numeric `_version` and `updatedAt` for LWW:

```ts
if (typeof remoteVersion === 'number') {
  const localVersion = typeof existing._version === 'number' ? existing._version : 0;
  if (remoteVersion < localVersion) return;
}
```

In peer mode, replace this with an HLC compare. The entity's `_version` field becomes an HLC object. The compare is lexicographic on `(ts, counter, nodeId)`.

For backward compat with MQDB mode: keep numeric `_version` as the comparison in `'mqdb'` mode, switch to HLC compare only in `'peer'` mode. The mode flag is read once and cached.

### 5.4 HLC location

HLC lives **per-entity record**, stored on the record itself (replacing `_version`). Not per-scope. This means cross-entity causality is not tracked — but that's fine because LWW only cares about same-entity ordering.

## 6. API surface changes

### 6.1 `StoreConfig`

Add:

```ts
syncMode?: 'mqdb' | 'peer';  // default 'mqdb' for backward compat
```

No other config additions. `syncTopicPrefix`, `responseTopicPrefix`, etc. still work.

### 6.2 `replaceScope` semantics

| Mode | Behavior |
|---|---|
| `'mqdb'` (today) | Awaits `openScope` → server returns full ScopeState → reconcile + load → resolve. UI sees complete state on resolve. |
| `'peer'` (new) | Subscribes to events, publishes `hello`, returns immediately. UI starts with whatever's in local IndexedDB. State populates over time as peer responses arrive. |

This is a deliberate API contract change in peer mode. App code that today does `await store.replaceScope(id); /* assume loaded */` must handle "still populating" UI states. The library will not provide a synthetic "loaded" gate because any such gate sneaks a timer back in.

App authors who need a "loaded" gate can implement one themselves: e.g. observe MemoryStore for stability (no new mutations for N seconds). That's an app-level policy choice, not a library responsibility.

### 6.3 `request()`

Throws in peer mode: `Error('request() is not supported in peer sync mode')`. `Store.request` on the public API documents this as a no-op in peer mode.

### 6.4 `bumpScopeVersion`

No-op in peer mode. Per-entity HLC handles ordering; there is no scope-level version.

### 6.5 `fetchList` / `fetchOne`

Not used in peer mode. The "initial state" comes from local IndexedDB (already-persisted) plus reactive `hello` replies from peers. There is no `fetchList(rootEntity)` to enumerate all root entities the user has access to — that information must arrive via the same `hello` mechanism, scoped at the user level (see §10 for top-level entities).

## 7. What changes in the existing code

### 7.1 `src/sync-engine.ts`

- Constructor reads `config.syncMode`, branches on it for the relevant methods.
- `createEntity` / `updateEntity` / `deleteEntity` in peer mode: compute the events topic, publish QoS 1 retain=false, no responseTopic, no await on reply. `data.id` (already injected by `StoreImpl.create` at `store.ts:239`) is the entity ID; no server-generated ID.
- `bumpScopeVersion`: no-op in peer mode.
- `openScope`: in peer mode, subscribe to `events/#`, publish `hello` with manifest (read from local accessor), return `{root: null, children: {}, version: 0, bufferedMutations: []}`. The state arrives reactively after return.
- `subscribeToTopLevel`: same `events/#` subscription.
- `handleWatchMessage`: same path. In peer mode, "buffered while awaitingState" doesn't apply (we don't await state).
- New: `handleHelloMessage` — subscribed by every client, reacts by diffing manifest against local state and publishing deltas.
- `request()`: throws in peer mode.

Estimated diff: ~250-400 LOC added, mostly contained in mode-branching `if` blocks. Most of the existing connection / reconnect / auth machinery is unchanged.

### 7.2 `src/remote-sync-layer.ts`

- `applyMutationToDb`: replace numeric `_version` compare with HLC compare. Single localized change.
- `syncRootEntityList`: in peer mode, this becomes "subscribe to top-level pattern, publish hello, react." Major refactor. May warrant extraction into a separate helper.
- `reconcileChildren`: not invoked in peer mode (no synchronous server snapshot to reconcile against).

### 7.3 `src/persistence-layer.ts`

- New: tombstone storage. A `_tombstones` table keyed by `(entity, id)`, holding `{hlc, deletedAt}`. New methods: `markDeleted(entity, id, hlc)`, `getTombstone(entity, id)`, `pruneTombstones(beforeTimestamp)`.
- `delete(entity, id)` writes a tombstone before (or instead of) actually removing the row in peer mode.

### 7.4 `src/types.ts`

- `StoreConfig.syncMode?: 'mqdb' | 'peer'`.
- HLC type definition.
- Entity-level HLC field (replaces or augments `_version` in peer mode).

### 7.5 `src/store.ts`

- No changes to mutation flow (already mode-agnostic at this layer).
- `replaceScope` may need a small branch: in peer mode, skip the `await sync.openScope` long path and just subscribe + publish `hello`.

## 8. Open questions

These are the corners I'm least sure about. Mark up your answers and we'll iterate.

### Q1: Hello flooding

If the scope has 10 peers and 1000 entities, every peer responding to `hello` floods the broker with 10× redundant mutation events. The new client deduplicates via HLC, so correctness is fine, but bandwidth is wasted.

Options:
- **Accept it** (do nothing). Reasonable for small scopes (a few peers).
- **Self-throttle**: each peer responds with probability `1/N` (N estimated from broker stats — but broker stats aren't usually available client-side).
- **Random delay before responding**: peer A waits 0-200ms; if it sees another peer respond first to entity X with same-or-newer HLC, peer A skips that entity. Still bounded but burns some events.
- **Hello manifest as Bloom filter** to reduce hello payload size for large local states. Doesn't address response flooding.

Recommendation: start with "accept it." Add throttling only if measurement shows it's needed.

### Q2: Tombstone retention

How long do clients retain tombstones? Forever is unbounded. Pruning too aggressively causes "delete that didn't propagate" bugs.

Options:
- Forever: simplest, unbounded growth.
- TTL (e.g. 30 days): prune anything older. A peer offline >30 days will see deleted entities resurrect (the missing tombstone means peers on bootstrap don't know to re-delete).
- TTL + offline-duration check: client tracks "longest-offline peer I've seen via hello" and only prunes tombstones older than that. Complex.

Recommendation: TTL (configurable, default 30 days). Document the "device offline > TTL" failure mode.

### Q3: Bootstrap with no peer online

If a fresh client opens a scope and **no peer is online**, the `hello` is broadcast into the void. The client sees only its local IndexedDB state (which may be empty for a brand-new device). When peers come online later, they don't know there's a recent newcomer to bootstrap unless **they** publish hello — but typically only the new joiner does that.

Options:
- **Re-publish hello periodically** (e.g. every 5 minutes) until at least one peer has responded. Adds a periodic timer (mild) but stays reactive in spirit.
- **Each peer publishes hello on connect**, not just newcomers. So every connect triggers a state exchange. Wasteful but symmetric.
- **Accept the limitation**: documented as "data is unreachable when no peer is online."

Recommendation: each peer publishes hello on every connect. Symmetric and doesn't require special-casing newcomers vs. returning peers.

### Q4: Multiple-scope users

Today, `syncRootEntityList` enumerates all root entities a user has access to via `fetchList(rootEntity)` — server-side filtering by `userScopeField`. In peer mode, there's no server to query.

Options:
- The user's "list of accessible scopes" is enumerated by subscribing to a top-level topic and reactively collecting hellos / mutation events. New top-level topic: `$DB/{root}/+/hello` — every scope's hello announcements are visible. Client builds the scope list reactively.
- Each user maintains a "my scopes" list as a separate top-level entity, kept in sync via the same peer mechanism.
- Out of scope for v1: peer mode supports a single known scope at a time; multi-scope discovery deferred.

Recommendation: out of scope for v1. Document as a known limitation.

### Q5: HLC overflow / counter explosion

If many mutations happen at the exact same `wallNow` ms, `counter` increments. JavaScript numbers safely represent up to 2^53. In practice this is not a real concern — even at 1M mutations/sec, you'd hit 2^53 in ~280 years. Skip.

### Q6: `sender` field vs HLC.nodeId

Today the `sender` field is used for own-message filtering (`isOwnMutation` at sync-engine.ts:519-523). In peer mode, HLC.nodeId could play the same role. Should we collapse them?

Recommendation: keep both for now (HLC for ordering, sender for filtering) — simpler diff, no semantic change. Collapse if the duplication bothers us in code review.

## 9. What this design does NOT solve

- **Peer that has unique data and is permanently offline.** That data is unreachable. No protocol short of CRDT replication to all peers solves this without a server.
- **Concurrent writes during a network partition** that resolve to LWW. One side's edit wins; the other is lost. CRDTs would merge both. If multi-user concurrent edits during partition is a real requirement, we need CRDTs and this design doesn't apply.
- **Strong consistency.** Stitch in peer mode is eventually consistent. Apps requiring read-your-writes consistency on a different device need MQDB mode.
- **Cross-scope queries / search.** No `fetchList(entity, filters)` against a global index. Apps needing this need MQDB mode.

These are honest trade-offs of going masterless. They should be documented prominently in the user-facing docs once this ships.

## 10. Estimated scope

Rough LOC budget for v1 (single-scope, no top-level entity discovery):

| File | Net change |
|---|---|
| `src/sync-engine.ts` | +250 |
| `src/remote-sync-layer.ts` | +60 (HLC compare, hello plumbing) |
| `src/persistence-layer.ts` | +120 (tombstone API) |
| `src/store.ts` | +30 (replaceScope branch) |
| `src/types.ts` | +40 (HLC type, syncMode field) |
| New: `src/hlc.ts` | +60 (HLC algorithm) |
| Tests | +500 (unit + integration with embedded broker e.g. aedes) |

~1100 LOC. Self-contained behind a config flag — MQDB mode is unaffected.

## 11. Implementation phasing

Once this design is approved:

1. **Phase 0**: this doc, plus the `$SYS` fix (already done in `fix/response-topic-default`).
2. **Phase 1**: HLC implementation + replace `_version` compare in `applyMutationToDb` (gated by mode flag, default `mqdb` keeps numeric `_version`). Tests.
3. **Phase 2**: Tombstone storage in PersistenceLayer. Tests.
4. **Phase 3**: Peer-mode SyncEngine — mutations as fire-and-forget events, `request()` throws.
5. **Phase 4**: `hello` protocol — client publishes, server reacts, manifest diffing.
6. **Phase 5**: Integration tests with embedded MQTT broker (aedes or similar).
7. **Phase 6**: Documentation updates (README, configuration.md, ARCHITECTURE.md).

Each phase is independently shippable behind the mode flag.

---

## Appendix A: Why not retained topics

Retained-topic mode (broker stores latest state of each entity) was the original direction. It has its own valid place but was rejected here because:

- Broker becomes the source of truth — pushes complexity onto the broker (storage, ACLs, retention).
- Settling timeout problem: no signal for "all retained delivered."
- Delete-as-empty-payload semantics are awkward.
- Doesn't solve the masterless coordination problem; just hides it inside the broker.

Peer-coordinated mode keeps the broker as a pure fanout, which is the cleanest mental model for users who are choosing between brokers.

## Appendix B: Why not full CRDT

CRDTs (Yjs, Automerge, Loro) provably solve concurrent merges. They were rejected for this initial cut because:

- Heavy dependencies (~50-200KB additional bundle).
- API rewrite: entity records become CRDT documents with type-specific quirks (text, map, list).
- Overkill for the primary use case (single-user multi-device, where concurrent partition writes are rare).

If concurrent-edit correctness becomes a real requirement, retrofitting CRDT-backed entities behind the same `peer` flag is possible without breaking the wire protocol — the events topic carries CRDT ops instead of full records.

## Appendix C: Spec references

- MQTT 5 §4.7.2: `$`-prefixed topic reservation.
- HLC: Kulkarni et al., "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases," 2014.
