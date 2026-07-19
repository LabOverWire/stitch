import { createStore } from '@laboverwire/stitch';
import type { StoreConfig, StoreOptions } from '@laboverwire/stitch';

export const DB_NAME = 'stitch-example';

export const config: StoreConfig = {
  entities: {
    project: {
      fields: [
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'createdAt', type: 'number' },
      ],
    },
    task: {
      fields: [
        { name: 'id', type: 'string' },
        { name: 'projectId', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'done', type: 'boolean', default: false },
        { name: 'createdAt', type: 'number' },
      ],
      foreignKeys: [{ field: 'projectId', references: 'project', onDelete: 'cascade' }],
      indexes: ['projectId'],
    },
  },
  scope: {
    rootEntity: 'project',
    childEntities: ['task'],
    scopeField: 'projectId',
  },
};

const serverUrl = import.meta.env.VITE_STITCH_SERVER_URL as string | undefined;
const authTicket = import.meta.env.VITE_STITCH_AUTH_TICKET as string | undefined;

const options: StoreOptions = {
  persistence: { dbName: DB_NAME },
  ...(serverUrl
    ? {
        remote: {
          url: serverUrl,
          ...(authTicket ? { ticket: authTicket } : {}),
        },
      }
    : {}),
};

export const store = createStore(config, options);

export const hasRemoteConfigured = Boolean(serverUrl);
