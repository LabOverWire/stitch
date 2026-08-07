import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { StoreConfig } from '../../src/types.ts';

describe('stitch-wasm 0.2.2 extended config fields', () => {
  it('localOnlyEntities: a local-only entity supports full CRUD without a scope', async () => {
    const store = createStore(
      projectTaskConfig({
        localOnlyEntities: {
          draft: {
            fields: [
              { name: 'id', type: 'string' },
              { name: 'body', type: 'string' },
            ],
          },
        },
      }),
      { persistence: { dbName: uniqueDbName() } }
    );
    await store.initialize();

    const id = await store.create('draft', '', { body: 'hello' });
    expect(id).toBeTruthy();
    expect(store.read('draft', id)).toMatchObject({ id, body: 'hello' });

    const listed = await store.list('draft');
    expect(listed.map((r) => r.id)).toContain(id);

    await store.update('draft', id, { body: 'world' });
    expect(store.read('draft', id)).toMatchObject({ id, body: 'world' });

    await store.delete('draft', id);
    expect(store.read('draft', id)).toBeNull();

    await store.destroy();
  });

  it('topLevelEntities: a top-level entity supports create/read/list', async () => {
    const config = projectTaskConfig({
      topLevelEntities: [{ entity: 'label', subscriptionPattern: 'label/#' }],
    });
    config.entities.label = {
      fields: [
        { name: 'id', type: 'string' },
        { name: 'text', type: 'string' },
      ],
    };
    const store = createStore(config, { persistence: { dbName: uniqueDbName() } });
    await store.initialize();

    const id = await store.create('label', '', { text: 'urgent' });
    expect(store.read('label', id)).toMatchObject({ id, text: 'urgent' });

    const listed = await store.list('label');
    expect(listed.map((r) => r.id)).toContain(id);

    await store.destroy();
  });

  it('accepts the full extended config surface and performs correct scoped CRUD', async () => {
    const config: StoreConfig = projectTaskConfig({
      syncTopicPrefix: '_db',
      responseTopicPrefix: '_rpc/responses',
      versionField: 'rev',
      updatedAtField: 'touchedAt',
      userScopeField: 'ownerId',
    });
    const store = createStore(config, { persistence: { dbName: uniqueDbName() } });
    await store.initialize();

    expect(store.ready).toBe(true);
    expect(store.config.syncTopicPrefix).toBe('_db');
    expect(store.config.responseTopicPrefix).toBe('_rpc/responses');
    expect(store.config.versionField).toBe('rev');
    expect(store.config.updatedAtField).toBe('touchedAt');
    expect(store.config.userScopeField).toBe('ownerId');

    store.setAuthenticatedUser('user-42');

    const id = await store.create('project', '', { name: 'P1' });
    await store.create('task', id, { projectId: id, title: 'T1', done: false });
    await store.replaceScope(id);

    expect(store.read('project', id)).toMatchObject({ id, name: 'P1' });
    expect(store.getSnapshot('task', id)).toHaveLength(1);

    await store.update('project', id, { name: 'P1b' });
    await store.replaceScope(id);
    expect(store.read('project', id)).toMatchObject({ id, name: 'P1b' });

    await store.destroy();
  });
});
