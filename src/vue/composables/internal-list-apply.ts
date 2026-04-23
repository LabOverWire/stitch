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
      const exists = prev.some((d) => d.id === item.id);
      if (exists) return prev.map((d) => (d.id === item.id ? item : d));
      return [...prev, item];
    }
    case 'update':
      return prev.map((d) => (d.id === item.id ? item : d));
    case 'delete':
      return prev.filter((d) => d.id !== item.id);
    default:
      return prev;
  }
}
