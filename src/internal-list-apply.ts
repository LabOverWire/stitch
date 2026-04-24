export type ListItem = Record<string, unknown> & { id: string };

export function applyEvent(
  prev: ListItem[],
  entity: unknown,
  op: 'insert' | 'update' | 'delete'
): ListItem[] {
  if (!entity || typeof entity !== 'object' || !('id' in entity)) return prev;
  const item = entity as ListItem;
  const idx = prev.findIndex((d) => d.id === item.id);
  switch (op) {
    case 'insert': {
      if (idx < 0) return [...prev, item];
      const next = prev.slice();
      next[idx] = item;
      return next;
    }
    case 'update': {
      if (idx < 0) return prev;
      const next = prev.slice();
      next[idx] = item;
      return next;
    }
    case 'delete': {
      if (idx < 0) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    }
    default:
      return prev;
  }
}
