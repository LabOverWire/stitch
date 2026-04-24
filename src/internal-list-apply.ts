export type ListItem = Record<string, unknown> & { id: string };

export function applyEvent(
  prev: ListItem[],
  entity: unknown,
  op: 'insert' | 'update' | 'delete'
): ListItem[] {
  if (!entity || typeof entity !== 'object' || !('id' in entity)) return prev;
  const item = entity as ListItem;
  switch (op) {
    case 'insert': {
      const idx = prev.findIndex((d) => d.id === item.id);
      if (idx < 0) return [...prev, item];
      const next = prev.slice();
      next[idx] = item;
      return next;
    }
    case 'update': {
      const idx = prev.findIndex((d) => d.id === item.id);
      if (idx < 0) return prev;
      const next = prev.slice();
      next[idx] = item;
      return next;
    }
    case 'delete': {
      const idx = prev.findIndex((d) => d.id === item.id);
      if (idx < 0) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    }
    default:
      return prev;
  }
}
