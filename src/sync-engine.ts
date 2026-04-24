import type {
  MqttClient,
  SubscribeOptions,
  PublishOptions,
  MessageProperties as WasmMsgProps,
} from 'mqtt5-wasm';
import type {
  StoreConfig,
  SyncMutation,
  ScopeState,
  ConnectionStatus,
  SortField,
  SyncEngine,
} from './types.ts';
import { OwnershipError } from './types.ts';

interface ChangeEvent {
  operation: 'Create' | 'Update' | 'Delete';
  entity: string;
  id: string;
  data: Record<string, unknown> | null;
  operation_id?: string;
  sequence?: number;
  sender?: string;
}

type MutationHandler = (scopeId: string, mutation: SyncMutation) => void;
type ConnectionStatusHandler = (status: ConnectionStatus) => void;

const FAST_RECONNECT_LIMIT = 5;
const SLOW_RECONNECT_INTERVAL = 15_000;

function applyTicketAuth(
  connectOpts: import('mqtt5-wasm').ConnectOptions,
  ticket: string | undefined
): void {
  if (!ticket) return;
  connectOpts.authenticationMethod = 'JWT';
  connectOpts.authenticationData = new TextEncoder().encode(ticket);
}

class SyncEngineImpl implements SyncEngine {
  private client: MqttClient | null = null;
  private readonly clientId: string;
  private readonly config: StoreConfig;
  private readonly prefix: string;
  private readonly responsePrefix: string;
  private SubscribeOptions: (new () => SubscribeOptions) | null = null;
  private PublishOptions: (new () => PublishOptions) | null = null;
  private ConnectOptions: (new () => import('mqtt5-wasm').ConnectOptions) | null = null;

  private desiredScopes = new Set<string>();
  private subscribedScopes = new Set<string>();
  private appliedVersion = new Map<string, number>();
  private buffered = new Map<string, SyncMutation[]>();
  private awaitingState = new Set<string>();
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private topLevelSubscribed = false;

  private onMutation: MutationHandler | null = null;
  private onConnectionStatus: ConnectionStatusHandler | null = null;
  private onSessionInvalid: (() => void) | null = null;
  private getTicket: (() => Promise<string>) | null = null;
  private active = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private slowReconnecting = false;
  private serverUrl: string | null = null;

  constructor(clientId: string, config: StoreConfig) {
    if (/[+#/]/.test(clientId)) {
      throw new Error('clientId must not contain MQTT special characters (+, #, /)');
    }
    this.clientId = clientId;
    this.config = config;
    this.prefix = config.syncTopicPrefix ?? '$DB';
    this.responsePrefix = config.responseTopicPrefix ?? '$SYS/responses';
  }

  async connect(
    serverUrl: string,
    wasmModule: unknown,
    getTicket?: () => Promise<string>
  ): Promise<void> {
    this.onConnectionStatus?.('connecting');
    this.active = true;
    this.serverUrl = serverUrl;

    if (getTicket) {
      this.getTicket = getTicket;
    }

    if (!this.client) {
      const mod = wasmModule as typeof import('mqtt5-wasm');
      const {
        default: initMqttWasm,
        MqttClient,
        ConnectOptions,
        SubscribeOptions,
        PublishOptions,
      } = mod;
      await initMqttWasm();
      this.client = new MqttClient(this.clientId);
      this.SubscribeOptions = SubscribeOptions;
      this.PublishOptions = PublishOptions;
      this.ConnectOptions = ConnectOptions;

      this.client.onConnect(() => {
        if (!this.active) return;
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;
        this.slowReconnecting = false;
        this.topLevelSubscribed = false;
        Promise.all([this.subscribeToResponseTopic(), this.subscribeToTopLevel()])
          .then(() => {
            if (this.active) this.onConnectionStatus?.('connected');
            for (const scopeId of this.desiredScopes) {
              this.subscribeToScope(scopeId)
                .then(() => this.subscribedScopes.add(scopeId))
                .catch((err) => console.error(`[SyncEngine] Re-subscribe ${scopeId} failed:`, err));
            }
          })
          .catch((err) => {
            console.error('[SyncEngine] Post-connect subscribe failed:', err);
            this.onConnectionStatus?.('error');
            this.scheduleReconnect();
          });
      });

      this.client.onDisconnect(() => {
        if (!this.active) return;
        if (this.reconnecting) return;
        this.onConnectionStatus?.('disconnected');
        this.cleanupOnDisconnect();
        if (this.client?.isBrowserOnline()) {
          this.scheduleReconnect();
        }
      });

      this.client.onError((error: string) => {
        if (!this.active) return;
        if (/closed by peer|connection reset/i.test(error)) return;
        if (/not.?authorized|bad.?user|bad.?password|authentication|0x8[567]/i.test(error)) {
          this.cancelReconnect();
          this.onSessionInvalid?.();
          return;
        }
        console.error('[SyncEngine] MQTT error:', error);
        this.onConnectionStatus?.('error');
      });

      this.client.onConnectivityChange((online: boolean) => {
        if (!this.active) return;
        if (!online) {
          this.cancelReconnect();
          this.onConnectionStatus?.('offline');
          this.cleanupOnDisconnect();
        } else {
          this.scheduleReconnect(0);
        }
      });
    }

    try {
      const connectOpts = new this.ConnectOptions!();
      connectOpts.cleanStart = true;
      connectOpts.keepAlive = 60;

      if (this.getTicket) {
        applyTicketAuth(connectOpts, await this.getTicket());
      }

      await this.client.connectWithOptions(serverUrl, connectOpts);
    } catch (err) {
      this.onConnectionStatus?.('disconnected');
      if (this.client?.isBrowserOnline()) {
        this.scheduleReconnect();
      }
      throw err;
    }
  }

  async reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void> {
    if (!this.client || !this.ConnectOptions) {
      throw new Error('Cannot reconnect before initial connect');
    }

    this.clearReconnectTimer();
    this.reconnecting = true;
    this.active = true;
    this.serverUrl = serverUrl;
    if (!this.slowReconnecting) {
      this.onConnectionStatus?.('connecting');
    }

    if (getTicket) {
      this.getTicket = getTicket;
    }

    try {
      this.client.disconnect();
    } catch {
      // WASM client may throw if already disconnected
    }

    let failed = false;
    try {
      const connectOpts = new this.ConnectOptions();
      connectOpts.cleanStart = true;
      connectOpts.keepAlive = 60;

      if (this.getTicket) {
        const ticket = await Promise.race([
          this.getTicket(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getTicket timeout')), 10_000)
          ),
        ]);
        applyTicketAuth(connectOpts, ticket);
      }

      await this.client.connectWithOptions(serverUrl, connectOpts);
    } catch (err) {
      if (err instanceof Error && err.name === 'SessionExpiredError') {
        this.cancelReconnect();
        this.onSessionInvalid?.();
        return;
      }
      failed = true;
      throw err;
    } finally {
      this.reconnecting = false;
      if (failed && this.active && this.client?.isBrowserOnline()) {
        this.scheduleReconnect();
      }
    }
  }

  private cleanupOnDisconnect(): void {
    this.subscribedScopes.clear();
    this.appliedVersion.clear();
    this.buffered.clear();
    this.awaitingState.clear();
    this.topLevelSubscribed = false;
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (this.reconnectTimer || this.reconnecting || !this.active || !this.serverUrl) return;

    if (!this.slowReconnecting && this.reconnectAttempt >= FAST_RECONNECT_LIMIT) {
      this.slowReconnecting = true;
      this.onConnectionStatus?.('disconnected');
    }

    const baseDelay = this.slowReconnecting
      ? SLOW_RECONNECT_INTERVAL
      : (delayOverride ?? Math.min(1000 * 2 ** this.reconnectAttempt, 30000));
    const jitter = Math.random() * (baseDelay / 4);
    const delay = Math.round(baseDelay + jitter);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.active || !this.serverUrl) return;

      this.reconnectAttempt++;
      try {
        await this.reconnect(this.serverUrl, this.getTicket ?? undefined);
      } catch {
        if (this.active && this.client?.isBrowserOnline()) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cancelReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.slowReconnecting = false;
  }

  disconnect(): void {
    this.active = false;
    this.reconnecting = false;
    this.cancelReconnect();
    this.cleanupOnDisconnect();
    try {
      this.client?.disconnect();
    } catch {
      // mqtt5-wasm may throw on disconnect
    }
  }

  setMutationHandler(handler: MutationHandler): void {
    this.onMutation = handler;
  }

  setConnectionStatusHandler(handler: ConnectionStatusHandler): void {
    this.onConnectionStatus = handler;
  }

  setSessionInvalidHandler(handler: () => void): void {
    this.onSessionInvalid = handler;
  }

  private async subscribeToResponseTopic(): Promise<void> {
    if (!this.client || !this.SubscribeOptions) return;
    const responseTopic = `${this.responsePrefix}/${this.clientId}/#`;
    const subOpts = new this.SubscribeOptions();
    subOpts.qos = 1;
    await this.client.subscribeWithOptions(
      responseTopic,
      (topic: string, payload: Uint8Array) => {
        this.handleResponseMessage(topic, payload);
      },
      subOpts
    );
  }

  private async subscribeToTopLevel(): Promise<void> {
    if (!this.client || !this.SubscribeOptions || this.topLevelSubscribed) return;
    const { rootEntity } = this.config.scope;

    const subOpts = new this.SubscribeOptions();
    subOpts.qos = 1;
    await this.client.subscribeWithOptions(
      `${this.prefix}/${rootEntity}/+/events/#`,
      (topic: string, payload: Uint8Array, properties?: WasmMsgProps) => {
        this.handleRootEntityEvent(topic, payload, properties);
      },
      subOpts
    );

    if (this.config.topLevelEntities) {
      for (const topLevel of this.config.topLevelEntities) {
        const tSubOpts = new this.SubscribeOptions!();
        tSubOpts.qos = 1;
        await this.client.subscribeWithOptions(
          topLevel.subscriptionPattern,
          (topic: string, payload: Uint8Array, properties?: WasmMsgProps) => {
            this.handleTopLevelEntityEvent(topLevel.entity, topic, payload, properties);
          },
          tSubOpts
        );
      }
    }

    this.topLevelSubscribed = true;
  }

  private handleRootEntityEvent(
    topic: string,
    payload: Uint8Array,
    properties?: WasmMsgProps
  ): void {
    const parsed = this.parseScopedTopic(topic);
    if (!parsed || parsed.entity !== this.config.scope.rootEntity) return;
    if (this.subscribedScopes.has(parsed.scopeId)) return;

    let event: ChangeEvent;
    try {
      const parsedPayload: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (!SyncEngineImpl.isValidChangeEvent(parsedPayload)) return;
      event = parsedPayload;
    } catch {
      return;
    }

    if (this.isOwnMutation(properties, event.sender)) return;

    const opMap: Record<string, ChangeEvent['operation']> = {
      created: 'Create',
      updated: 'Update',
      deleted: 'Delete',
    };
    event.operation = opMap[parsed.eventType] ?? event.operation;

    const mutation = SyncEngineImpl.mapChangeEvent(this.config.scope.rootEntity, event);
    this.applyMutation('__global__', mutation);
  }

  private handleTopLevelEntityEvent(
    entityName: string,
    topic: string,
    payload: Uint8Array,
    properties?: WasmMsgProps
  ): void {
    const match = topic.match(new RegExp(`^\\${this.prefix}/${entityName}/events/(.+)$`));
    if (!match) return;

    let event: ChangeEvent;
    try {
      const parsedPayload: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (!SyncEngineImpl.isValidChangeEvent(parsedPayload)) return;
      event = parsedPayload;
    } catch {
      return;
    }

    if (this.isOwnMutation(properties, event.sender)) return;

    const mutation = SyncEngineImpl.mapChangeEvent(entityName, event);
    this.applyMutation('__global__', mutation);
  }

  private handleResponseMessage(topic: string, payload: Uint8Array): void {
    const match = topic.match(new RegExp(`^\\${this.responsePrefix}/[^/]+/(.+)$`));
    if (!match) return;

    const requestId = match[1];
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      try {
        const response = JSON.parse(new TextDecoder().decode(payload));
        pending.resolve(response);
      } catch {
        pending.reject(new Error('Invalid response format'));
      }
    }
  }

  private async subscribeToScope(scopeId: string): Promise<void> {
    if (!this.client || !this.SubscribeOptions) return;
    const { rootEntity } = this.config.scope;

    const subOpts = new this.SubscribeOptions();
    subOpts.qos = 1;
    await this.client.subscribeWithOptions(
      `${this.prefix}/${rootEntity}/${scopeId}/#`,
      (topic: string, payload: Uint8Array, properties?: WasmMsgProps) => {
        this.handleWatchMessage(topic, payload, properties);
      },
      subOpts
    );
  }

  private async unsubscribeFromScope(scopeId: string): Promise<void> {
    if (!this.client) return;
    const { rootEntity } = this.config.scope;
    await this.client.unsubscribe(`${this.prefix}/${rootEntity}/${scopeId}/#`);
  }

  private static isValidChangeEvent(value: unknown): value is ChangeEvent {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as Record<string, unknown>;
    return (
      typeof e.id === 'string' &&
      e.id.length > 0 &&
      typeof e.operation === 'string' &&
      ['Create', 'Update', 'Delete'].includes(e.operation) &&
      (e.data === undefined || e.data === null || typeof e.data === 'object')
    );
  }

  private static mapChangeEvent(entity: string, event: ChangeEvent): SyncMutation {
    const opMap: Record<string, SyncMutation['op']> = {
      Create: 'insert',
      Update: 'update',
      Delete: 'delete',
    };
    return {
      op: opMap[event.operation] ?? 'update',
      entity,
      id: event.id,
      data: event.data ?? null,
      operationId: event.operation_id ?? null,
    };
  }

  private parseScopedTopic(
    topic: string
  ): { scopeId: string; entity: string; eventType: string } | null {
    const { rootEntity } = this.config.scope;

    const rootOwn = topic.match(
      new RegExp(`^\\${this.prefix}/${rootEntity}/([^/]+)/events/(created|updated|deleted)$`)
    );
    if (rootOwn) {
      return { scopeId: rootOwn[1], entity: rootEntity, eventType: rootOwn[2] };
    }

    const childEntity = topic.match(
      new RegExp(`^\\${this.prefix}/${rootEntity}/([^/]+)/(\\w+)/events/(created|updated|deleted)$`)
    );
    if (childEntity) {
      return { scopeId: childEntity[1], entity: childEntity[2], eventType: childEntity[3] };
    }

    return null;
  }

  private static extractOriginClientId(properties?: WasmMsgProps): string | null {
    if (!properties) return null;
    const userProps = properties.getUserProperties();
    for (let i = 0; i < userProps.length; i++) {
      const [key, value] = userProps[i] as [string, string];
      if (key === 'x-origin-client-id') return value;
    }
    return null;
  }

  private isOwnMutation(properties?: WasmMsgProps, eventSender?: string): boolean {
    if (eventSender === this.clientId) return true;
    const origin = SyncEngineImpl.extractOriginClientId(properties);
    return origin === this.clientId;
  }

  private handleWatchMessage(topic: string, payload: Uint8Array, properties?: WasmMsgProps): void {
    const parsed = this.parseScopedTopic(topic);
    if (!parsed) return;

    const { scopeId, entity, eventType } = parsed;

    let event: ChangeEvent;
    try {
      const parsedPayload: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (!SyncEngineImpl.isValidChangeEvent(parsedPayload)) return;
      event = parsedPayload;
    } catch {
      return;
    }

    const opMap: Record<string, ChangeEvent['operation']> = {
      created: 'Create',
      updated: 'Update',
      deleted: 'Delete',
    };
    event.operation = opMap[eventType] ?? event.operation;

    if (this.isOwnMutation(properties, event.sender)) return;

    const mutation = SyncEngineImpl.mapChangeEvent(entity, event);

    if (this.awaitingState.has(scopeId)) {
      this.buffered.get(scopeId)?.push(mutation);
      return;
    }

    this.applyMutation(scopeId, mutation);
  }

  private applyMutation(scopeId: string, mutation: SyncMutation): void {
    this.onMutation?.(scopeId, mutation);
  }

  async openScope(scopeId: string): Promise<ScopeState> {
    if (!this.client) throw new Error('Not connected');

    const { rootEntity, childEntities, scopeField } = this.config.scope;

    this.desiredScopes.add(scopeId);
    this.awaitingState.add(scopeId);
    this.buffered.set(scopeId, []);
    this.subscribedScopes.add(scopeId);

    try {
      await this.subscribeToScope(scopeId);

      const fetchPromises: Promise<Record<string, unknown>[] | null>[] = childEntities.map(
        (entity) => this.fetchList(entity, scopeId)
      );

      const [rootRecord, ...childResults] = await Promise.all([
        this.fetchOne(rootEntity, scopeId),
        ...fetchPromises,
      ]);

      const root = rootRecord ?? {};
      const children: Record<string, Record<string, unknown>[]> = {};
      for (let i = 0; i < childEntities.length; i++) {
        children[childEntities[i]] = childResults[i] ?? [];
      }

      const versionField = this.config.versionField ?? 'version';
      const version = (root[versionField] as number) || 0;
      this.appliedVersion.set(scopeId, version);

      const buffer = this.buffered.get(scopeId) || [];
      const bufferedMutations: SyncMutation[] = [];
      for (const mutation of buffer) {
        const belongsToScope =
          mutation.entity === rootEntity
            ? mutation.id === scopeId
            : (mutation.data?.[scopeField] as string | undefined) === scopeId;
        if (belongsToScope) {
          bufferedMutations.push(mutation);
        }
      }

      this.buffered.delete(scopeId);
      this.awaitingState.delete(scopeId);

      return { root, children, version, bufferedMutations };
    } catch (err) {
      this.buffered.delete(scopeId);
      this.awaitingState.delete(scopeId);
      this.subscribedScopes.delete(scopeId);
      throw err;
    }
  }

  async closeScope(scopeId: string): Promise<void> {
    this.desiredScopes.delete(scopeId);
    this.subscribedScopes.delete(scopeId);
    this.buffered.delete(scopeId);
    this.awaitingState.delete(scopeId);
    this.appliedVersion.delete(scopeId);
    await this.unsubscribeFromScope(scopeId);
  }

  private checkResponseAndAuth(response: Record<string, unknown>): void {
    if (response.status === 'error') {
      const msg = (response.message as string) || 'Operation failed';
      if (response.code === 401) {
        this.onSessionInvalid?.();
        throw new Error(msg);
      }
      if (response.code === 403) {
        throw new OwnershipError(msg);
      }
      throw new Error(msg);
    }
  }

  private extractResponseId(response: Record<string, unknown>): string {
    const data = response.data;
    if (typeof data !== 'object' || data === null) {
      throw new Error('Response missing data payload');
    }
    const id = (data as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Response missing valid id');
    }
    return id;
  }

  async createEntity(
    entity: string,
    scopeId: string | null,
    data: Record<string, unknown>
  ): Promise<string> {
    const { scopeField, childEntities } = this.config.scope;
    const isChild = childEntities.includes(entity);
    const payload = isChild && scopeId ? { ...data, [scopeField]: scopeId } : data;

    const response = await this.request(`${this.prefix}/${entity}/create`, payload);
    this.checkResponseAndAuth(response);
    const id = this.extractResponseId(response);

    if (isChild && scopeId) {
      await this.bumpScopeVersion(scopeId);
    }

    return id;
  }

  async updateEntity(
    entity: string,
    scopeId: string | null,
    id: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const response = await this.request(`${this.prefix}/${entity}/${id}/update`, data);
    this.checkResponseAndAuth(response);

    const { childEntities } = this.config.scope;
    if (childEntities.includes(entity) && scopeId) {
      await this.bumpScopeVersion(scopeId);
    }
  }

  async deleteEntity(entity: string, scopeId: string | null, id: string): Promise<void> {
    const response = await this.request(`${this.prefix}/${entity}/${id}/delete`, {});
    this.checkResponseAndAuth(response);

    const { childEntities } = this.config.scope;
    if (childEntities.includes(entity) && scopeId) {
      await this.bumpScopeVersion(scopeId);
    }
  }

  async bumpScopeVersion(scopeId: string): Promise<void> {
    const { rootEntity } = this.config.scope;
    const versionField = this.config.versionField ?? 'version';
    const updatedAtField = this.config.updatedAtField ?? 'updatedAt';
    const now = Date.now();

    const response = await this.request(`${this.prefix}/${rootEntity}/${scopeId}/update`, {
      [versionField]: now,
      [updatedAtField]: now,
    });
    this.checkResponseAndAuth(response);
    this.appliedVersion.set(scopeId, now);
  }

  private async fetchOne(entity: string, id: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.request(`${this.prefix}/${entity}/${id}`, {});
      this.checkResponseAndAuth(response);
      return response.data as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async fetchList(
    entity: string,
    scopeId?: string,
    sort?: SortField[]
  ): Promise<Record<string, unknown>[] | null> {
    try {
      const payload: Record<string, unknown> = {};
      if (scopeId) {
        const { scopeField } = this.config.scope;
        payload.filters = [{ field: scopeField, op: 'eq', value: scopeId }];
      }
      if (sort && sort.length > 0) {
        payload.sort = sort;
      }
      const response = await this.request(`${this.prefix}/${entity}/list`, payload);
      this.checkResponseAndAuth(response);
      return (response.data as Record<string, unknown>[]) || [];
    } catch {
      return null;
    }
  }

  async request(topic: string, payload: unknown): Promise<Record<string, unknown>> {
    if (!this.client || !this.PublishOptions) throw new Error('Not connected');

    const requestId = crypto.randomUUID();
    const responseTopic = `${this.responsePrefix}/${this.clientId}/${requestId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, 10000);

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as Record<string, unknown>);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const encoder = new TextEncoder();
      const pubOpts = new this.PublishOptions!();
      pubOpts.qos = 1;
      pubOpts.retain = false;
      pubOpts.responseTopic = responseTopic;
      pubOpts.correlationData = encoder.encode(requestId);

      const body = JSON.stringify(payload);

      this.client!.publishWithOptions(topic, encoder.encode(body), pubOpts).catch((err: Error) => {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  get isReconnecting(): boolean {
    return this.reconnecting || this.reconnectTimer !== null;
  }

  isSubscribedTo(scopeId: string): boolean {
    return this.subscribedScopes.has(scopeId);
  }

  getAppliedVersion(scopeId: string): number {
    return this.appliedVersion.get(scopeId) || 0;
  }
}

export function createSyncEngine(clientId: string, config: StoreConfig): SyncEngine {
  return new SyncEngineImpl(clientId, config);
}
