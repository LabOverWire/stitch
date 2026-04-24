import { describe, it, expect } from 'vitest';
import { applyEvent } from '../../src/internal-list-apply.ts';

describe('applyEvent', () => {
  it('insert adds new item', () => {
    const item = { id: 'a', name: 'A' };
    expect(applyEvent([], item, 'insert')).toEqual([item]);
  });

  it('insert replaces existing item with same id', () => {
    const prev = [{ id: 'a', name: 'A' }];
    const next = { id: 'a', name: 'A2' };
    expect(applyEvent(prev, next, 'insert')).toEqual([next]);
  });

  it('update applies to existing item', () => {
    const prev = [{ id: 'a', name: 'A' }];
    const next = { id: 'a', name: 'A2' };
    expect(applyEvent(prev, next, 'update')).toEqual([next]);
  });

  it('update on missing id is a no-op (stale-event safety)', () => {
    const prev = [{ id: 'a', name: 'A' }];
    const fresh = { id: 'b', name: 'B' };
    expect(applyEvent(prev, fresh, 'update')).toBe(prev);
  });

  it('delete removes existing item', () => {
    const prev = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    expect(applyEvent(prev, { id: 'a' }, 'delete')).toEqual([{ id: 'b', name: 'B' }]);
  });

  it('stale update after delete must NOT resurrect the deleted row', () => {
    const row = { id: 'a', name: 'A' };
    let list: Array<Record<string, unknown> & { id: string }> = [row];
    list = applyEvent(list, row, 'delete');
    expect(list).toEqual([]);
    const staleUpdate = { id: 'a', name: 'A (stale)' };
    list = applyEvent(list, staleUpdate, 'update');
    expect(list).toEqual([]);
  });
});
