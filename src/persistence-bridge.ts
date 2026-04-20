import type { MemoryStore, PersistenceStore, MutationEvent } from './types.ts';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_SKIP_TAGS = new Set(['remote', 'load', 'clear']);

export interface PersistenceBridgeConfig {
  maxQueueSize?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  skipTags?: Set<string>;
  scopeField?: string;
}

export interface PersistenceBridge {
  start(): void;
  stop(): void;
}

class PersistenceBridgeImpl implements PersistenceBridge {
  private readonly memoryStore: MemoryStore;
  private readonly persistenceStore: PersistenceStore;
  private readonly maxQueueSize: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly skipTags: Set<string>;
  private readonly scopeField: string | null;

  private unsubscribe: (() => void) | null = null;
  private started = false;
  private queue: MutationEvent[] = [];
  private flushing = false;
  private retryPending = false;
  private retryCount = new WeakMap<MutationEvent, number>();

  constructor(
    memoryStore: MemoryStore,
    persistenceStore: PersistenceStore,
    config?: PersistenceBridgeConfig
  ) {
    this.memoryStore = memoryStore;
    this.persistenceStore = persistenceStore;
    this.maxQueueSize = config?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = config?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.skipTags = config?.skipTags ?? DEFAULT_SKIP_TAGS;
    this.scopeField = config?.scopeField ?? null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribe = this.memoryStore.onMutation((event) => {
      if (event.originTag != null && this.skipTags.has(event.originTag)) {
        return;
      }
      this.queue.push(event);
      if (this.queue.length > this.maxQueueSize) {
        const dropped = this.queue.shift();
        console.warn(
          `[PersistenceBridge] Queue full, dropping oldest: ${dropped?.operation} ${dropped?.entity} ${dropped?.id}`
        );
      }
      this.flush();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    this.queue = [];
    this.retryPending = false;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.retryPending) return;
    this.flushing = true;

    try {
      while (this.queue.length > 0) {
        const event = this.queue[0];
        try {
          await this.processMutation(event);
          this.queue.shift();
        } catch (err) {
          const attempt = this.retryCount.get(event) ?? 0;
          if (attempt < this.maxRetries) {
            this.retryCount.set(event, attempt + 1);
            const delay = this.retryBaseMs * Math.pow(2, attempt);
            this.retryPending = true;
            setTimeout(() => {
              this.retryPending = false;
              this.flush();
            }, delay);
          } else {
            this.queue.shift();
            console.error(
              `[PersistenceBridge] ${event.operation} ${event.entity} ${event.id} permanently failed after ${this.maxRetries} retries:`,
              err
            );
          }
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async processMutation(event: MutationEvent): Promise<void> {
    const { operation, entity, id, data } = event;

    switch (operation) {
      case 'create':
        if (data) {
          await this.persistenceStore.create(entity, { ...data, id });
        }
        break;
      case 'update':
        if (data) {
          const fields = { ...data };
          delete fields.id;
          if (this.scopeField) delete fields[this.scopeField];
          await this.persistenceStore.update(entity, id, fields);
        }
        break;
      case 'delete':
        await this.persistenceStore.delete(entity, id);
        break;
    }
  }
}

export function createPersistenceBridge(
  memoryStore: MemoryStore,
  persistenceStore: PersistenceStore,
  config?: PersistenceBridgeConfig
): PersistenceBridge {
  return new PersistenceBridgeImpl(memoryStore, persistenceStore, config);
}
