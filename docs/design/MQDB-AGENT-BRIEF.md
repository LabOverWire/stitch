# MQDB agent brief — reactive scope-open

**Audience:** whoever (human or agent) is implementing the MQDB server-side changes for stitch's reactive `replaceScope`. This document is **self-contained**: all wire-format excerpts and protocol contracts are quoted inline so you do not need to read stitch's source tree to do the work. Pointers into stitch source are provided for verification only.

> **Note (stitch 0.5.0):** the TypeScript store/sync/persistence layer was replaced by the `@laboverwire/stitch-wasm` package (compiled from the sibling `stitch-rs` repo). `@laboverwire/stitch` is now a thin binding layer. The wire format below is unchanged, but the source pointers that used to name `src/sync-engine.ts` / `src/remote-sync-layer.ts` now refer to that wasm implementation — those `.ts` files were removed.

**Scope:** the changes needed in MQDB to support `docs/design/reactive-scope-open.md`. Peer mode (`docs/design/reactive-peer-mode.md`) is a separate workstream and out of scope for this brief.

---

## 1. What you are implementing in one sentence

When a stitch client publishes a `hello` message naming a scope, MQDB should diff the client's manifest against server state and emit per-record events on the existing scope events topic, instead of waiting for the client to poll via `fetchList` / `fetchOne` request/reply.

This collapses bootstrap and live-sync onto one streaming channel and removes ~10s of blocking time from `replaceScope` on slow networks.

## 2. Why this is needed (60-second version)

Today every stitch `replaceScope(scopeId)` does:

1. Subscribe to the scope's events topic (already streaming).
2. **Block** on `Promise.all([fetchOne(root), fetchList(child) × N])` — N parallel request/reply round-trips, each with a 10s client-side timeout.
3. Buffer events arriving during step 2 so they don't get lost.
4. After step 2 resolves, drain the buffer and return.

Step 2 is the user-visible wait. The new flow removes step 2 entirely: client publishes `hello`, server replays per-record events on the same topic the client is already subscribed to. Client never blocks on a snapshot.

Full motivation, file:line analysis, and trade-offs: `docs/design/reactive-scope-open.md` §1.

## 3. Wire format you must produce and consume

### 3.1 Topic structure (existing — unchanged)

`syncTopicPrefix` defaults to `$DB` (configurable). `responseTopicPrefix` defaults to `$DB/clients` (configurable).

```
$DB/{rootEntity}/{scopeId}/events/{created|updated|deleted}              # root mutations
$DB/{rootEntity}/{scopeId}/{childEntity}/events/{created|updated|deleted} # child mutations
$DB/{rootEntity}/{scopeId}/hello                                          # NEW — client subscribe-and-replay request
$DB/clients/{clientId}/{requestId}                                        # response topic for one-shot replies
```

`{eventType}` in the topic and `operation` in the payload must agree per the mapping in §3.2.

Source of truth in stitch: the scoped-topic parser in `@laboverwire/stitch-wasm` (formerly `parseScopedTopic` in `src/sync-engine.ts`, removed in 0.5.0) — matches both root-own and child topics.

### 3.2 ChangeEvent payload (the one MQDB must emit on event topics)

This is the JSON shape stitch parses on every `events/{type}` topic. **Both real mutation events and synthetic replay events must conform.**

```ts
interface ChangeEvent {
  operation: 'Create' | 'Update' | 'Delete';   // capitalized
  entity: string;                                // entity type, e.g. "task"
  id: string;                                    // record id (also appears in topic)
  data: Record<string, unknown> | null;          // full record for Create/Update; null OK for Delete
  operation_id?: string;                         // optional idempotency key
  sequence?: number;                             // optional, currently unused by client
  sender?: string;                               // origin client id; see §3.4
}
```

Validation in stitch (in `@laboverwire/stitch-wasm`; formerly `isValidChangeEvent` in `src/sync-engine.ts`):

- `id` is a non-empty string.
- `operation` is exactly one of `'Create' | 'Update' | 'Delete'` (note capitalization).
- `data` is an object, `null`, or absent.

Anything that fails validation is silently dropped by stitch. Make sure replay events conform.

**Topic-to-operation mapping** (handled in `@laboverwire/stitch-wasm`): the topic suffix is lowercase past tense, the payload field is capitalized infinitive:

| Topic suffix | Payload `operation` |
|---|---|
| `events/created` | `Create` |
| `events/updated` | `Update` |
| `events/deleted` | `Delete` |

Stitch overrides the payload's `operation` with the topic-derived value, so they must agree. Use both consistently.

### 3.3 MQTT user properties

Stitch sets these on outgoing publishes and reads them on incoming messages. MQDB must do the same.

| User property | Set by stitch on publish? | Read by stitch on receive? | Purpose |
|---|---|---|---|
| `x-origin-client-id` | Yes (own clientId) | Yes — used in `isOwnMutation` filter | Prevents loop-back: stitch ignores any event whose `x-origin-client-id` matches its own clientId. |

`isOwnMutation` (in `@laboverwire/stitch-wasm`) returns true if **either** `event.sender === clientId` **or** the user property `x-origin-client-id === clientId`. Both mechanisms are honored; either is sufficient.

For replay events MQDB emits, see §3.5 — the `sender` value is reserved.

### 3.4 Request/reply envelope (existing — unchanged)

Mutation requests (which stay request/reply per `reactive-scope-open.md` §1.3) use:

- **Publish:** topic `$DB/{entity}/create` (or `update` / `delete`), payload is the JSON record.
- **MQTT properties on the request:** `responseTopic = $DB/clients/{clientId}/{requestId}`, `correlationData = utf8({requestId})` where `{requestId}` is a UUID generated by stitch.
- **Reply:** server publishes to the `responseTopic` the JSON shape:

```ts
interface RequestResponse {
  status: 'ok' | 'error';
  code?: number;        // 401 = session invalid, 403 = ownership violation, others = generic error
  message?: string;     // human-readable error
  data?: unknown;       // payload on success (e.g. created record with server-assigned fields)
}
```

Source: the request/reply envelope and response status handling in `@laboverwire/stitch-wasm` (formerly `request()` and `checkResponseAndAuth` in `src/sync-engine.ts`, removed in 0.5.0).

### 3.5 NEW: Synthetic replay events

When MQDB processes a `hello` (§4) and emits replay events, those events:

- Use the **same topics** as live mutations (`events/created` / `events/updated` / `events/deleted`).
- Use the **same payload shape** as §3.2.
- Carry `sender: '__server_replay__'` in the payload **AND** set the MQTT user property `x-origin-client-id` to a server-fixed sentinel (suggest: `'__mqdb_server__'`). Neither value matches any real client id, so all clients (including the requesting one) will accept the events.
- The fan-out cost is intentional: existing peers on the scope receive replay events too. They apply them via the existing `_version` LWW compare (in `@laboverwire/stitch-wasm`; formerly `src/remote-sync-layer.ts`), which no-ops when the version matches. Bandwidth cost accepted as the price of one channel.

### 3.6 NEW: `hello` payload (client → server)

Client publishes one message:

- **Topic:** `${syncTopicPrefix}/{rootEntity}/{scopeId}/hello`
- **QoS:** 1, `retain: false`
- **No `responseTopic`, no `correlationData`** — fire-and-forget.
- **Payload:**

```ts
interface HelloPayload {
  clientId: string;                              // requesting client id
  manifest: Array<{ id: string; version: number }>;  // root + children currently in client's local IndexedDB for this scope
}
```

`version` is the numeric `_version` field on each record. For a fresh client, manifest is `[]`.

### 3.7 NEW: `scope-open-error` reply (server → client, error path)

When MQDB rejects a `hello` due to auth (the requesting client has no access to `scopeId`), MQDB publishes one message and stops:

- **Topic:** `${responseTopicPrefix}/{clientId}/scope-open-error`
- **Payload:**

```ts
interface ScopeOpenError {
  scopeId: string;
  code: number;        // 401 | 403 | other
  message: string;     // human-readable
}
```

This is the only out-of-band reply during scope-open. There is no "I'm done replaying" message on the success path.

## 4. Server behavior on `hello`

Pseudo-code for the handler:

```
on_hello(message):
  payload = parse_json(message.payload)
  client_id = payload.clientId
  scope_id = extract_scope_id_from_topic(message.topic)
  manifest = payload.manifest

  # 1. Auth
  if not session_has_access(client_id, scope_id):
    publish(
      topic = "$DB/clients/{client_id}/scope-open-error",
      payload = { scopeId: scope_id, code: 403, message: "..." }
    )
    return

  # 2. Rate limit (see §6 of this brief)
  if not rate_limiter.allow(client_id, scope_id):
    return  # silent drop

  # 3. Diff
  client_versions = { entry.id: entry.version for entry in manifest }
  server_state = load_scope(scope_id)  # root + all children + any tombstones

  for record in server_state.records:
    client_v = client_versions.get(record.id)
    if client_v is None or client_v < record._version:
      emit_replay_event(record, "Create" if client_v is None else "Update")

  for tombstone in server_state.tombstones:
    client_v = client_versions.get(tombstone.id)
    if client_v is not None and client_v < tombstone.deleted_at_version:
      emit_replay_event_delete(tombstone)

  # No "done" message. Client never expects one.

emit_replay_event(record, op):
  topic = "$DB/{root}/{scope}/events/{op_lower}"  # or .../{child_entity}/events/{op_lower}
  payload = {
    operation: op,                # capitalized
    entity: record.entity_type,
    id: record.id,
    data: record.full_data,
    sender: "__server_replay__",
  }
  user_properties = { "x-origin-client-id": "__mqdb_server__" }
  publish(topic, payload, user_properties, qos=1, retain=false)
```

**Statelessness:** if the client disconnects mid-replay and republishes `hello` on reconnect, run the handler from scratch. Do not track per-client replay progress.

## 5. Server behavior on mutations (changes from today)

Per-mutation request/reply stays. **Two changes:**

### 5.1 Emit `events/{type}` for every mutation (already done?)

Whatever path MQDB uses today to broadcast mutations to peers stays in place. Replay events use the same path; just with the `__server_replay__` sender.

### 5.2 Emit a `events/updated` for the root entity on every child mutation

Today the client calls `bumpScopeVersion` after each child create/update/delete to bump the root's `_version` and `updatedAt`. In the new flow, **the server does this implicitly** when it processes the child mutation:

1. Process the child mutation as today.
2. Increment the root entity's `_version`, set `updatedAt = now()`.
3. Emit a synthetic `events/updated` for the root with the new version.

Removes one round-trip per child mutation from the client. Stitch will stop calling `bumpScopeVersion` (it's deleted in the client-side patch — see `reactive-scope-open.md` §4.1).

## 6. Server-side requirements (full checklist)

This is the consolidated checklist from `reactive-scope-open.md` §4.4.1. Each item references its motivating section in that doc.

**New protocol handlers**

- [ ] Subscribe to `${syncTopicPrefix}/+/+/hello` (per-tenant equivalent acceptable). [§2.1]
- [ ] On hello: auth-validate against `userScopeField`. On failure, publish `ScopeOpenError` to `${responseTopicPrefix}/{clientId}/scope-open-error`. [§2.2 step 1]
- [ ] On hello: compute manifest diff (server-has-newer + server-has-tombstone-newer). Emit replay events. [§2.2 step 2]
- [ ] Replay is stateless. No per-client progress tracking; reconnect republishes hello and the server replays from scratch. [§2.4]

**New broadcast behaviors**

- [ ] Synthetic replay events use real `events/{type}` topics. Fan-out to existing peers is accepted as the cost of one channel. [§2.2]
- [ ] Synthetic events carry `sender: '__server_replay__'` in the payload and `x-origin-client-id: '__mqdb_server__'` as a user property. [§4.2]
- [ ] On every child mutation: bump root `_version` and `updatedAt`, emit a synthetic `events/updated` for the root. Replaces client-driven `bumpScopeVersion`. [§2.5]
- [ ] During the deprecation window (§8 Phase 4): emit per-record events while keeping `fetchList` / `fetchOne` handlers working. After the window, remove the handlers. [§3.4 + §8]

**New persistence requirements**

- [ ] Tombstone tracking. The server must retain *some* record of deletions (e.g. a `_deleted_at` column kept indefinitely, or a tombstone table) so it can publish `events/deleted` to a client whose manifest still lists a record the server has since removed. If MQDB today does hard deletes, this is a real schema change. Retention policy (forever vs TTL) is open — see `reactive-peer-mode.md` §8/Q2 for the same trade-off. [§2.2]

**New connection-time advertisement**

- [ ] On CONNACK, set the MQTT 5 User Property `stitch-protocol-version: 2` (or whatever version label is agreed). Stitch falls back to the legacy `fetchList` flow if this property is absent. [§5/Q2]

**New operational concerns**

- [ ] Hello rate limiting per `(clientId, scopeId)`. Suggested floor: at most one replay per pair per 5–10s. Drop or silently NACK excess. [§4.4.1]

**Out of scope for v1**

- [ ] Top-level entity discovery via hello. Same shape but on the discovery topic. Deferred — keep `fetchList(rootEntity)` working for v1. [§5/Q3]

## 7. Implementation phasing (server side)

This mirrors `reactive-scope-open.md` §8. The split lets you ship server changes incrementally without a hard cutover on the client.

1. **Phase 0** — agree on this brief. Confirm tombstone-tracking approach, capability label, rate-limit defaults.
2. **Phase 1** — implement `hello` subscription and replay logic. `fetchList` / `fetchOne` handlers stay alongside. Behind a feature flag if you want to dark-launch.
3. **Phase 2** — emit `stitch-protocol-version: 2` on CONNACK. Stitch starts routing scope-open through the new path.
4. **Phase 3** — implement implicit version-bump on child mutations. Coordinate with stitch removing `bumpScopeVersion` client-side.
5. **Phase 4** — telemetry confirms no clients fall back. Remove `fetchList` / `fetchOne` handlers (and `bumpScopeVersion` request handler) from MQDB.

Each phase is independently shippable.

## 8. Open questions you may need to escalate

These are flagged in `reactive-scope-open.md` §5 but worth pulling forward:

1. **Tombstone retention TTL.** Forever is unbounded growth. TTL means clients offline longer than TTL see deleted records resurrect. Recommendation: configurable, default 30 days. Document the limit.
2. **Auth-failure surfacing on the client.** Should `replaceScope` reject when a `scope-open-error` arrives, or fire a store-level event? Affects only the client API but you'll want to know which contract the client picks. Recommendation: store-level event.
3. **Rate-limit response on excess.** Silent drop or publish a `ScopeOpenError` with a `code: 429`-style payload? Silent drop is simpler; explicit reply lets buggy clients surface the issue. Recommendation: explicit `code: 429` after the third drop in a window.

## 9. References (for verification only — this brief is self-contained)

- `docs/design/reactive-scope-open.md` — full design rationale, client-side changes, phasing, open questions.
- `docs/design/reactive-peer-mode.md` — adjacent design (peer-coordinated mode); §8/Q2 has tombstone retention discussion that applies here.
- `@laboverwire/stitch-wasm` (compiled from the sibling `stitch-rs` repo) — wire-format truth. As of stitch 0.5.0 the store/sync/persistence layers moved out of this repo into the wasm; the `ChangeEvent` shape, scoped-topic parsing, change-event validation (`isValidChangeEvent`), origin-client filtering (`extractOriginClientId` / `isOwnMutation`), the scoped event handler, the request/reply envelope (`request()` / `checkResponseAndAuth`), and the mutation request handlers (`createEntity` / `updateEntity` / `deleteEntity` / `bumpScopeVersion`) all live there. The former TypeScript sources were removed: `src/sync-engine.ts` (which defined the private `ChangeEvent` interface) and `src/remote-sync-layer.ts`, along with the `SyncMutation` and `OwnershipError` type defs in `src/types.ts`. The inline excerpts in §3 remain the authoritative contract regardless of implementation language.
