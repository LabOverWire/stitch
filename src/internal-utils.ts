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
  return /timeout|disconnected|foreign key violation/i.test(err.message);
}
