import { createStore as createWasmStore } from '@laboverwire/stitch-wasm';
import type { Store as WasmStore } from '@laboverwire/stitch-wasm';
import type {
  ConnectionStatus,
  DefaultSchema,
  EntityKey,
  EntitySchema,
  ListFilter,
  MemoryStore,
  OriginTag,
  SortField,
  Store,
  StoreConfig,
  StoreOptions,
} from './types.ts';

const EMPTY_ARRAY: Record<string, unknown>[] = [];
const EMPTY_MAP: Record<string, Record<string, unknown>> = {};

function normalizeStatus(raw: string): ConnectionStatus {
  switch (raw) {
    case 'Connected':
      return 'connected';
    case 'Connecting':
      return 'connecting';
    case 'Disconnected':
      return 'disconnected';
    case 'Error':
      return 'error';
    default:
      return 'offline';
  }
}

function cacheKey(scopeId: string, entity: string): string {
  return `${scopeId} ${entity}`;
}

/**
 * Wire a subscription now if the store is ready, otherwise defer wiring until
 * `whenReady` resolves. Returns an unsubscribe that cancels the pending wire or
 * the live subscription, whichever exists. `poke` fires once the deferred
 * subscription attaches so `useSyncExternalStore`-style consumers re-read.
 */
function deferrableSubscribe(
  isReady: () => boolean,
  whenReady: () => Promise<void>,
  subscribeNow: () => () => void,
  poke: () => void
): () => void {
  if (isReady()) return subscribeNow();
  let live: (() => void) | null = null;
  let cancelled = false;
  void whenReady().then(() => {
    if (cancelled) return;
    live = subscribeNow();
    poke();
  });
  return () => {
    cancelled = true;
    if (live) {
      live();
      live = null;
    }
  };
}

class MemoryView implements MemoryStore {
  #inner: WasmStore;
  #whenReady: () => Promise<void>;
  #arrays = new Map<string, { version: number; data: Record<string, unknown>[] }>();
  #maps = new Map<string, { version: number; data: Record<string, Record<string, unknown>> }>();

  constructor(inner: WasmStore, whenReady: () => Promise<void>) {
    this.#inner = inner;
    this.#whenReady = whenReady;
  }

  getSnapshot(entity: string, scopeId: string): Record<string, unknown>[] {
    if (!this.#inner.ready()) return EMPTY_ARRAY;
    const version = this.#inner.getVersion(scopeId, entity);
    const key = cacheKey(scopeId, entity);
    const hit = this.#arrays.get(key);
    if (hit && hit.version === version) return hit.data;
    const data = this.#inner.getSnapshot(entity, scopeId) as Record<string, unknown>[];
    this.#arrays.set(key, { version, data });
    return data;
  }

  getSnapshotAsMap(entity: string, scopeId: string): Record<string, Record<string, unknown>> {
    if (!this.#inner.ready()) return EMPTY_MAP;
    const version = this.#inner.getVersion(scopeId, entity);
    const key = cacheKey(scopeId, entity);
    const hit = this.#maps.get(key);
    if (hit && hit.version === version) return hit.data;
    const data = this.#inner.getSnapshotAsMap(entity, scopeId) as Record<
      string,
      Record<string, unknown>
    >;
    this.#maps.set(key, { version, data });
    return data;
  }

  subscribeToScope(scopeId: string, entity: string, callback: () => void): () => void {
    return deferrableSubscribe(
      () => this.#inner.ready(),
      this.#whenReady,
      () => this.#inner.subscribeToScope(scopeId, entity, callback) as () => void,
      callback
    );
  }
}

class StitchStore<S extends EntitySchema = DefaultSchema> implements Store<S> {
  readonly config: StoreConfig;
  readonly memory: MemoryStore;
  #inner: WasmStore;
  #memory: MemoryView;
  #hasPersistence: boolean;
  #hasRemote: boolean;
  #reconnectValidator: (() => Promise<void>) | null = null;
  #readyPromise: Promise<void>;
  #resolveReady!: () => void;

  constructor(inner: WasmStore, config: StoreConfig, options: StoreOptions) {
    this.#inner = inner;
    this.config = config;
    this.#hasPersistence = options.persistence != null;
    this.#hasRemote = options.remote != null;
    this.#readyPromise = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.#memory = new MemoryView(inner, () => this.#readyPromise);
    this.memory = this.#memory;
  }

  #afterReady<T>(fn: () => Promise<T>): Promise<T> {
    return this.#inner.ready() ? fn() : this.#readyPromise.then(fn);
  }

  async initialize(): Promise<void> {
    await this.#inner.initialize();
    this.#resolveReady();
  }

  destroy(): Promise<void> {
    return this.#inner.ready() ? this.#inner.destroy() : Promise.resolve();
  }

  get ready(): boolean {
    return this.#inner.ready();
  }

  read<K extends EntityKey<S>>(entity: K, id: string): S[K] | null {
    if (!this.#inner.ready()) return null;
    return (this.#inner.read(entity, id) ?? null) as S[K] | null;
  }

  getSnapshot<K extends EntityKey<S>>(entity: K, scopeId: string): S[K][] {
    return this.#memory.getSnapshot(entity, scopeId) as S[K][];
  }

  getSnapshotAsMap<K extends EntityKey<S>>(entity: K, scopeId: string): Record<string, S[K]> {
    return this.#memory.getSnapshotAsMap(entity, scopeId) as Record<string, S[K]>;
  }

  list<K extends EntityKey<S>>(entity: K, filter?: ListFilter): Promise<S[K][]> {
    return this.#afterReady(() => this.#inner.list(entity, filter ?? {})) as Promise<S[K][]>;
  }

  listRootEntities(sort?: SortField[]): Promise<Record<string, unknown>[]> {
    return this.#afterReady(() => this.#inner.listRootEntities(sort ?? [])) as Promise<
      Record<string, unknown>[]
    >;
  }

  getChildCount<K extends EntityKey<S>>(entity: K, scopeId: string): number {
    if (!this.#inner.ready()) return 0;
    return this.#inner.getChildCount(entity, scopeId);
  }

  getVersion<K extends EntityKey<S>>(scopeId: string, entity: K): number {
    if (!this.#inner.ready()) return 0;
    return this.#inner.getVersion(scopeId, entity);
  }

  create<K extends EntityKey<S>>(
    entity: K,
    scopeId: string,
    data: Partial<S[K]> & Record<string, unknown>,
    tag?: OriginTag
  ): Promise<string> {
    return this.#afterReady(() => this.#inner.create(entity, scopeId, data, tag ?? undefined));
  }

  update<K extends EntityKey<S>>(
    entity: K,
    id: string,
    fields: Partial<S[K]>,
    tag?: OriginTag
  ): Promise<void> {
    return this.#afterReady(() => this.#inner.update(entity, id, fields, tag ?? undefined));
  }

  delete<K extends EntityKey<S>>(entity: K, id: string, tag?: OriginTag): Promise<void> {
    return this.#afterReady(() => this.#inner.delete(entity, id, tag ?? undefined));
  }

  subscribeToScope<K extends EntityKey<S>>(
    scopeId: string,
    entity: K,
    callback: () => void
  ): () => void {
    return deferrableSubscribe(
      () => this.#inner.ready(),
      () => this.#readyPromise,
      () => this.#inner.subscribeToScope(scopeId, entity, callback) as () => void,
      callback
    );
  }

  subscribeToEntity<K extends EntityKey<S>>(
    entity: K,
    callback: (data: S[K] | null, op: 'insert' | 'update' | 'delete') => void
  ): () => void {
    return deferrableSubscribe(
      () => this.#inner.ready(),
      () => this.#readyPromise,
      () =>
        this.#inner.subscribeToEntity(entity, (data: unknown, op: 'insert' | 'update' | 'delete') =>
          callback((data ?? null) as S[K] | null, op)
        ) as () => void,
      () => callback(null, 'update')
    );
  }

  beginBatch(): void {
    if (this.#inner.ready()) this.#inner.beginBatch();
  }

  endBatch(): void {
    if (this.#inner.ready()) this.#inner.endBatch();
  }

  replaceScope(scopeId: string): Promise<void> {
    return this.#afterReady(() => this.#inner.replaceScope(scopeId));
  }

  closeScope(scopeId: string): Promise<void> {
    return this.#afterReady(() => this.#inner.closeScope(scopeId));
  }

  loadScope(scopeId: string, data: Record<string, Record<string, unknown>[]>): Promise<void> {
    return this.#afterReady(() => this.#inner.loadScope(scopeId, data));
  }

  clearScope(scopeId: string): Promise<void> {
    return this.#afterReady(() => this.#inner.clearScope(scopeId));
  }

  get connectionStatus(): ConnectionStatus {
    if (!this.#inner.ready()) return 'offline';
    return normalizeStatus(this.#inner.connectionStatus());
  }

  subscribeToConnectionStatus(cb: (s: ConnectionStatus) => void): () => void {
    return deferrableSubscribe(
      () => this.#inner.ready(),
      () => this.#readyPromise,
      () =>
        this.#inner.subscribeToConnectionStatus((raw: string) =>
          cb(normalizeStatus(raw))
        ) as () => void,
      () => cb(normalizeStatus(this.#inner.connectionStatus()))
    );
  }

  disconnect(): Promise<void> {
    return this.#inner.ready() ? this.#inner.disconnect() : Promise.resolve();
  }

  async reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void> {
    if (this.#reconnectValidator) await this.#reconnectValidator();
    const ticket = getTicket ? await getTicket() : undefined;
    await this.#inner.reconnect(serverUrl, ticket ?? undefined);
  }

  get isReconnecting(): boolean {
    if (!this.#inner.ready()) return false;
    return this.#inner.isReconnecting();
  }

  setAuthenticatedUser(userId: string): void {
    if (this.#inner.ready()) this.#inner.setAuthenticatedUser(userId);
    else void this.#readyPromise.then(() => this.#inner.setAuthenticatedUser(userId));
  }

  setSessionInvalidHandler(handler: () => void): void {
    if (this.#inner.ready()) this.#inner.setSessionInvalidHandler(handler);
    else void this.#readyPromise.then(() => this.#inner.setSessionInvalidHandler(handler));
  }

  setReconnectValidator(validator: () => Promise<void>): void {
    this.#reconnectValidator = validator;
  }

  resetForLogout(): Promise<void> {
    return this.#inner.ready() ? this.#inner.resetForLogout() : Promise.resolve();
  }

  readLocalState(entity: string, id: string): Promise<Record<string, unknown> | null> {
    return this.#afterReady(() =>
      this.#inner
        .readLocalState(entity, id)
        .then((r: unknown) => (r ?? null) as Record<string, unknown> | null)
    );
  }

  updateLocalState(entity: string, id: string, fields: Record<string, unknown>): Promise<void> {
    return this.#afterReady(() => this.#inner.updateLocalState(entity, id, fields));
  }

  pendingMutationCount(scopeId: string): Promise<number> {
    return this.#afterReady(() => this.#inner.pendingMutationCount(scopeId));
  }

  request(topic: string, payload: unknown): Promise<Record<string, unknown>> {
    return this.#afterReady(() => this.#inner.request(topic, payload)) as Promise<
      Record<string, unknown>
    >;
  }

  get hasPersistence(): boolean {
    return this.#hasPersistence;
  }

  get hasRemote(): boolean {
    return this.#hasRemote;
  }
}

export function createStore<S extends EntitySchema = DefaultSchema>(
  config: StoreConfig,
  options?: StoreOptions
): Store<S> {
  const resolvedOptions = options ?? {};
  const inner = createWasmStore(config, resolvedOptions);
  return new StitchStore<S>(inner, config, resolvedOptions);
}
