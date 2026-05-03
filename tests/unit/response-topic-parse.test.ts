import { describe, it, expect } from 'vitest';
import { parseResponseRequestId } from '../../src/internal-utils.ts';

describe('parseResponseRequestId', () => {
  it('extracts requestId from current default prefix', () => {
    const requestId = parseResponseRequestId(
      '$DB/clients',
      'client-abc',
      '$DB/clients/client-abc/req-123'
    );
    expect(requestId).toBe('req-123');
  });

  it('extracts requestId from legacy $SYS/responses prefix', () => {
    const requestId = parseResponseRequestId(
      '$SYS/responses',
      'client-abc',
      '$SYS/responses/client-abc/req-456'
    );
    expect(requestId).toBe('req-456');
  });

  it('extracts requestId from a non-$ custom prefix (regression: old regex broke here)', () => {
    const requestId = parseResponseRequestId(
      'responses',
      'client-abc',
      'responses/client-abc/req-789'
    );
    expect(requestId).toBe('req-789');
  });

  it('handles a multi-segment custom prefix', () => {
    const requestId = parseResponseRequestId(
      'app/v2/responses',
      'node-1',
      'app/v2/responses/node-1/uuid-abc'
    );
    expect(requestId).toBe('uuid-abc');
  });

  it('returns null when topic targets a different clientId', () => {
    expect(
      parseResponseRequestId('$DB/clients', 'client-abc', '$DB/clients/other-client/req-1')
    ).toBeNull();
  });

  it('returns null when topic prefix does not match', () => {
    expect(
      parseResponseRequestId('$DB/clients', 'client-abc', '$DB/other/client-abc/req-1')
    ).toBeNull();
  });

  it('returns null when requestId segment is empty', () => {
    expect(
      parseResponseRequestId('$DB/clients', 'client-abc', '$DB/clients/client-abc/')
    ).toBeNull();
  });

  it('returns null when requestId would contain a slash (deeper subtopic)', () => {
    expect(
      parseResponseRequestId('$DB/clients', 'client-abc', '$DB/clients/client-abc/req/extra')
    ).toBeNull();
  });

  it('returns null for an unrelated topic on the same broker', () => {
    expect(
      parseResponseRequestId('$DB/clients', 'client-abc', '$DB/task/scope-1/events/created')
    ).toBeNull();
  });
});
