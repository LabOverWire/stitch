import { describe, it, expect } from 'vitest';
import { MqdbError, wrapWasmError } from '../../src/internal-wasm-error.ts';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

describe('MqdbError wrapping', () => {
  it('wraps string throws into MqdbError with method name and cause', () => {
    const err = wrapWasmError('read:project', 'raw wasm message');
    expect(err).toBeInstanceOf(MqdbError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MqdbError');
    expect(err.method).toBe('read:project');
    expect(err.message).toBe('mqdb.read:project: raw wasm message');
    expect(err.cause).toBe('raw wasm message');
  });

  it('wraps Error throws preserving the cause', () => {
    const original = new Error('transaction error');
    const wrapped = wrapWasmError('delete:task', original);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.stack).toBeTruthy();
  });

  it('does not re-wrap an existing MqdbError', () => {
    const original = wrapWasmError('read:a', 'x');
    const again = wrapWasmError('read:b', original);
    expect(again).toBe(original);
  });

  it('surfaces wrapped errors for failed persistence ops', async () => {
    const dbName = uniqueDbName();
    const store = createStore(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();

    // Filtering on an unknown field surfaces the underlying mqdb error as an MqdbError.
    let caught: unknown;
    try {
      await store.list('project', { sort: [{ field: 'does-not-exist', direction: 'asc' }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MqdbError);
    expect((caught as MqdbError).method).toBe('list:project');
    expect((caught as MqdbError).message).toContain('mqdb.list:project:');

    store.destroy();
  });
});
