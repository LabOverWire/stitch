import type { StoreConfig } from '../../src/types.ts';

let counter = 0;

export function uniqueDbName(prefix = 'stitch-test'): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export function projectTaskConfig(overrides?: Partial<StoreConfig>): StoreConfig {
  return {
    dbName: uniqueDbName(),
    entities: {
      project: {
        fields: [
          { name: 'id', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      },
      task: {
        fields: [
          { name: 'id', type: 'string' },
          { name: 'projectId', type: 'string' },
          { name: 'title', type: 'string' },
          { name: 'done', type: 'boolean', default: false },
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
    ...overrides,
  };
}
