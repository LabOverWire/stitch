export function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value != null) {
      result[key] = value;
    }
  }
  return result;
}

export function isTransientSyncError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /timeout|disconnected/i.test(err.message);
}

export function isPermanentMutationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /unique constraint violation|foreign key violation|not null violation|cascade blocked|referenced by other entities/i.test(
    err.message
  );
}

export function parseResponseRequestId(
  responsePrefix: string,
  clientId: string,
  topic: string
): string | null {
  const expected = `${responsePrefix}/${clientId}/`;
  if (!topic.startsWith(expected)) return null;
  const requestId = topic.slice(expected.length);
  if (!requestId || requestId.includes('/')) return null;
  return requestId;
}
