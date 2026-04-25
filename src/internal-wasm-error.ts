export class MqdbError extends Error {
  readonly method: string;

  constructor(method: string, cause: unknown) {
    const rawMessage = cause instanceof Error ? cause.message : String(cause);
    super(`mqdb.${method}: ${rawMessage}`, { cause });
    this.name = 'MqdbError';
    this.method = method;
  }
}

export function wrapWasmError(method: string, cause: unknown): MqdbError {
  if (cause instanceof MqdbError) return cause;
  return new MqdbError(method, cause);
}

export function wrapSync<T>(method: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw wrapWasmError(method, err);
  }
}

export async function wrapAsync<T>(method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw wrapWasmError(method, err);
  }
}

const BASE_CORRUPTION_PATTERNS = ['arg0 is null', 'transaction error', 'unreachable'] as const;

export function isCorruptionError(err: unknown, extraPatterns: readonly string[] = []): boolean {
  const inner = err instanceof MqdbError ? err.cause : err;
  if (inner instanceof Error && inner.name === 'RuntimeError') return true;
  const msg = (inner instanceof Error ? inner.message : String(inner)).toLowerCase();
  for (const pattern of BASE_CORRUPTION_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }
  for (const pattern of extraPatterns) {
    if (msg.includes(pattern)) return true;
  }
  const txIdx = msg.indexOf('transaction');
  return txIdx !== -1 && msg.indexOf('null', txIdx) !== -1;
}
