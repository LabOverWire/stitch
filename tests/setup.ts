// Running in a real browser via Playwright — IndexedDB, WASM, and `window` all work natively.
// Wipe databases between test files so state doesn't leak across the suite. Every test uses
// a unique db name (see uniqueDbName), so leftover stores aren't contested; this cleanup is
// best-effort housekeeping with a short per-db timeout so a stuck handle can't hang the suite.

import { beforeEach } from 'vitest';

async function deleteDb(name: string): Promise<void> {
  return new Promise((res) => {
    const req = indexedDB.deleteDatabase(name);
    const timer = setTimeout(res, 500);
    const done = () => {
      clearTimeout(timer);
      res();
    };
    req.onsuccess = done;
    req.onerror = done;
    req.onblocked = done;
  });
}

beforeEach(async () => {
  const dbs = await indexedDB.databases();
  await Promise.all(dbs.filter((d) => d.name).map((d) => deleteDb(d.name as string)));
});
