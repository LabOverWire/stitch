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
