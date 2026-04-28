import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInMemoryOfflineQueue } from '../../src/offline-queue.ts';
import { OwnershipError } from '../../src/types.ts';
import type { MutationSender, PendingMutation } from '../../src/types.ts';

type SenderImpl = {
  syncCreate: ReturnType<typeof vi.fn>;
  syncUpdate: ReturnType<typeof vi.fn>;
  syncDelete: ReturnType<typeof vi.fn>;
  readEntity: ReturnType<typeof vi.fn>;
  deleteEntity: ReturnType<typeof vi.fn>;
};

function makeSender(overrides: Partial<MutationSender> = {}): SenderImpl & MutationSender {
  return {
    syncCreate: vi.fn().mockResolvedValue(undefined),
    syncUpdate: vi.fn().mockResolvedValue(undefined),
    syncDelete: vi.fn().mockResolvedValue(undefined),
    readEntity: vi.fn().mockResolvedValue({}),
    deleteEntity: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as SenderImpl & MutationSender;
}

const insertMutation = (
  overrides: Partial<PendingMutation> = {}
): PendingMutation => ({
  op: 'insert',
  entity: 'topics',
  id: 'topic-1',
  scopeId: 'project-1',
  data: { id: 'topic-1', path: '/foo' },
  ...overrides,
});

describe('offline queue flush — error classification', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('transient error (timeout) leaves mutation in queue and does NOT log a drop', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue(insertMutation());

    const sender = makeSender({
      syncCreate: vi.fn().mockRejectedValue(new Error('timeout waiting for response')),
    });

    await queue.flush(sender);

    const pending = await queue.getPendingForScope('project-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].entity).toBe('topics');

    const droppedLogs = errorSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Dropping mutation')
    );
    expect(droppedLogs).toEqual([]);
  });

  it('transient error (disconnected) keeps mutation queued; resumes on reconnect', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue(insertMutation());

    const failingSender = makeSender({
      syncCreate: vi.fn().mockRejectedValue(new Error('client disconnected from broker')),
    });
    await queue.flush(failingSender);
    expect(await queue.getPendingForScope('project-1')).toHaveLength(1);

    const recoveredSender = makeSender();
    await queue.flush(recoveredSender);

    expect(recoveredSender.syncCreate).toHaveBeenCalledTimes(1);
    expect(await queue.getPendingForScope('project-1')).toHaveLength(0);
  });

  it('permanent constraint error (unique constraint violation on update) drops the mutation', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue({ ...insertMutation(), op: 'update' });

    const sender = makeSender({
      syncUpdate: vi
        .fn()
        .mockRejectedValue(new Error('unique constraint violation: topics.path')),
    });

    await queue.flush(sender);

    expect(await queue.getPendingForScope('project-1')).toHaveLength(0);
    const dropLog = errorSpy.mock.calls.find((args) =>
      typeof args[0] === 'string' && args[0].includes('Dropping mutation after permanent error')
    );
    expect(dropLog).toBeDefined();
  });

  it('permanent constraint error (foreign key violation) drops the mutation (regression: was transient)', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue({ ...insertMutation(), op: 'update' });

    const sender = makeSender({
      syncUpdate: vi.fn().mockRejectedValue(new Error('foreign key violation: topics.parent_id')),
    });

    await queue.flush(sender);

    expect(await queue.getPendingForScope('project-1')).toHaveLength(0);
  });

  it('insert that hits unique constraint is recovered via update (conflict path)', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue(insertMutation());

    const sender = makeSender({
      syncCreate: vi
        .fn()
        .mockRejectedValue(new Error('unique constraint violation: topics.id')),
    });

    await queue.flush(sender);

    expect(sender.syncUpdate).toHaveBeenCalledTimes(1);
    expect(await queue.getPendingForScope('project-1')).toHaveLength(0);
  });

  it('unknown error drops mutation after one attempt (intentional behavior change in 0.4.2)', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue(insertMutation());

    const sender = makeSender({
      syncCreate: vi.fn().mockRejectedValue(new Error('unexpected server explosion')),
    });

    await queue.flush(sender);

    expect(await queue.getPendingForScope('project-1')).toHaveLength(0);
    const dropLog = errorSpy.mock.calls.find((args) =>
      typeof args[0] === 'string' && args[0].includes('Dropping mutation after unknown error')
    );
    expect(dropLog).toBeDefined();
  });

  it('OwnershipError drops mutation without logging a permanent/unknown drop', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue(insertMutation());

    const sender = makeSender({
      syncCreate: vi.fn().mockRejectedValue(new OwnershipError('not your entity')),
    });

    await queue.flush(sender);

    expect(await queue.getPendingForScope('project-1')).toHaveLength(0);
    const droppedLogs = errorSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Dropping mutation')
    );
    expect(droppedLogs).toEqual([]);
  });

  it('mid-flush: first mutation transient, second permanent — only the permanent one drops', async () => {
    const queue = createInMemoryOfflineQueue('project');
    await queue.queue(insertMutation({ id: 'topic-1', data: { id: 'topic-1', path: '/a' } }));
    await queue.queue(insertMutation({ id: 'topic-2', data: { id: 'topic-2', path: '/b' } }));

    const syncCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('not null violation: topics.path'));
    const sender = makeSender({ syncCreate });

    await queue.flush(sender);

    const remaining = await queue.getPendingForScope('project-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('topic-1');
  });
});
