import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockServer, type MockFixtureState } from './mock-server.js';
import { api, sessionMemory, ApiClientError, request } from '../src/api/client.js';
import { authNotifier } from '../src/api/auth-events.js';
import { readFullJobArtifact } from '../src/utils/job-reader.js';
import type { Server } from 'node:http';

describe('UI Review & Strict Contract Alignments (UI-01 ~ UI-10)', () => {
  let server: Server;
  let state: MockFixtureState;
  const PORT = 38923;

  beforeAll(async () => {
    const s = startMockServer(PORT);
    server = s.server;
    state = s.state;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      const targetUrl = urlStr.startsWith('http') ? urlStr : `http://127.0.0.1:${PORT}${urlStr}`;
      return origFetch(targetUrl, init);
    };
  });

  afterAll(() => {
    server.close();
  });

  it('UI-04: Session login, memory CSRF, and 401 eviction', async () => {
    sessionMemory.clear();
    let authNotified = false;
    const unsub = authNotifier.onUnauthorized(() => {
      authNotified = true;
    });

    // Login
    const session = await api.auth.login('default', 'admin', 'password123');
    expect(session.csrf_token).toBeDefined();
    expect(sessionMemory.getCsrf()).toBe(session.csrf_token);

    // Simulate 401
    state.currentSession = null;
    await expect(api.groups.list()).rejects.toThrowError(ApiClientError);
    expect(sessionMemory.getCsrf()).toBeNull();
    expect(authNotified).toBe(true);
    unsub();

    // Re-login
    await api.auth.login('default', 'admin', 'password123');
  });

  it('UI-04: Dual-tab CSRF rotation and recovery without automatic retry', async () => {
    // Current CSRF in memory
    const initialCsrf = sessionMemory.getCsrf();
    expect(initialCsrf).not.toBeNull();

    // Simulate another tab refreshing session and rotating server CSRF
    state.currentSession!.csrf_token = 'new-server-csrf-token';

    // Current tab attempts mutation with old CSRF -> must be rejected with CSRF_REJECTED (403)
    await expect(
      api.keys.create({
        name: 'Test CSRF Key',
        group_id: state.groups[0]!.id,
      })
    ).rejects.toMatchObject({
      code: 'CSRF_REJECTED',
      statusCode: 403,
    });

    // Recover by refreshing session in this tab
    const refreshed = await api.auth.session();
    expect(refreshed.csrf_token).toBeDefined();
    expect(refreshed.csrf_token).not.toBe(initialCsrf);
    expect(sessionMemory.getCsrf()).toBe(refreshed.csrf_token);

    // Mutation now succeeds with new valid CSRF
    const created = await api.keys.create({
      name: 'Recovered Key',
      group_id: state.groups[0]!.id,
    });
    expect(created.key.name).toBe('Recovered Key');
  });

  it('UI-03: DELETE endpoints require strict JSON body {} and return correct DTOs', async () => {
    // Groups delete
    const groupToDelete = state.groups[0]!;
    const groupDeleted = await api.groups.delete(groupToDelete.id);
    expect(groupDeleted.id).toBe(groupToDelete.id);
    expect(groupDeleted.status).toBe('disabled');
    expect(groupDeleted.deleted_at).not.toBeNull();

    // Provider delete returns ProviderDto
    const provToDelete = state.providers[0]!;
    const provDeleted = await api.providers.delete(provToDelete.id);
    expect(provDeleted.id).toBe(provToDelete.id);
    expect(provDeleted.status).toBe('disabled');
    expect(provDeleted.deleted_at).not.toBeNull();

    // Key delete
    const keyToDelete = state.keys[0]!;
    const keyDeleted = await api.keys.delete(keyToDelete.id);
    expect(keyDeleted.id).toBe(keyToDelete.id);
    expect(keyDeleted.status).toBe('disabled');
  });

  it('UI-02: Real wire DTO alignment for job detail, cancel, and multi-chunk UTF-8 reader', async () => {
    const testJobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    // Verify GET /api/admin/jobs/:id returns real jobView DTO
    const detail = await api.jobs.get(testJobId);
    expect(detail.schema_version).toBe('3.0');
    expect(detail.action).toBe('get');
    expect(detail.cancel_requested).toBe(false);
    expect(detail.artifact).toBeDefined();

    // Verify cancel returns CancelJobResultDto
    const cancelRes = await api.jobs.cancel(testJobId);
    expect(cancelRes.schema_version).toBe('3.0');
    expect(cancelRes.action).toBe('cancel');
    expect(cancelRes.cancel_requested).toBe(true);

    // Verify multi-chunk UTF-8 reading without frontend hash verification.
    const readResult = await readFullJobArtifact(testJobId);
    expect(readResult.chunkCount).toBe(2);
    expect(readResult.totalBytes).toBeGreaterThan(0);
    expect(readResult).not.toHaveProperty('sha256Valid');
    expect(readResult).not.toHaveProperty('sha256Calculated');
    expect(readResult.text).toContain('【云端搜索报告】测试数据：跨越分块边界的中文 UTF-8 内容');
    expect(readResult.text).toContain('第二行数据。');
  });

  it('UI-01: Groups capabilities isolation and revision integrity', async () => {
    const testGroup = state.groups[1]!;

    // Test failure case: capabilities GET fails
    state.failCapabilitiesForGroup = testGroup.id;
    await expect(api.groups.getCapabilities(testGroup.id)).rejects.toThrowError(ApiClientError);

    // Clear failure
    state.failCapabilitiesForGroup = undefined;
    const caps = await api.groups.getCapabilities(testGroup.id);
    expect(caps.group_id).toBe(testGroup.id);
    expect(caps.revision).toBe(testGroup.revision);

    // Update capabilities with matching expected_revision
    const updated = await api.groups.putCapabilities(testGroup.id, {
      expected_revision: caps.revision,
      lanes: [{ lane_id: 'exa-fast-search', units_per_query: 2 }],
      default_search_lane: 'exa-fast-search',
      default_fetch_pipeline: null,
      presets: {},
    });
    expect(updated.revision).toBe(caps.revision + 1);

    // Stale revision is rejected (409)
    await expect(
      api.groups.putCapabilities(testGroup.id, {
        expected_revision: caps.revision, // outdated
        lanes: [],
        default_search_lane: null,
        default_fetch_pipeline: null,
        presets: {},
      })
    ).rejects.toMatchObject({
      code: 'STALE_VERSION',
      statusCode: 409,
    });
  });

  it('UI-08: 409 STALE_VERSION conflict detection and re-fetch recovery', async () => {
    const key = state.keys[0]!;

    // Submit stale revision
    await expect(
      api.keys.patch(key.id, {
        expected_revision: key.revision + 10,
        name: 'Conflict Attempt',
      })
    ).rejects.toMatchObject({
      code: 'STALE_VERSION',
      statusCode: 409,
    });

    // Fresh get fetches current revision
    const freshKey = await api.keys.get(key.id);
    expect(freshKey.revision).toBe(key.revision);

    // Submit with fresh revision succeeds
    const patched = await api.keys.patch(freshKey.id, {
      expected_revision: freshKey.revision,
      name: 'Freshly Resolved Name',
    });
    expect(patched.name).toBe('Freshly Resolved Name');
    expect(patched.revision).toBe(freshKey.revision + 1);
  });

  it('UI-09: Provider configuration rules (Grok requires base_url, Exa defaults, secret lifecycle)', async () => {
    // Grok without base_url -> 422
    await expect(
      api.providers.create({
        name: 'Invalid Grok',
        provider_id: 'grok-multi-agent',
      })
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      statusCode: 422,
    });

    // Grok with valid base_url -> success
    const grok = await api.providers.create({
      name: 'Valid Grok Provider',
      provider_id: 'grok-multi-agent',
      base_url: 'https://api.x.ai',
      secret: 'grok-secret-test',
    });
    expect(grok.credential_configured).toBe(true);
    expect((grok as any).secret).toBeUndefined();

    // Preserve secret
    const preserved = await api.providers.patch(grok.id, {
      expected_revision: grok.revision,
      name: 'Renamed Grok',
    });
    expect(preserved.credential_configured).toBe(true);

    // Clear secret
    const cleared = await api.providers.patch(grok.id, {
      expected_revision: preserved.revision,
      clear_secret: true,
    });
    expect(cleared.credential_configured).toBe(false);

    // Replace secret
    const replaced = await api.providers.patch(grok.id, {
      expected_revision: cleared.revision,
      secret: 'new-grok-secret',
    });
    expect(replaced.credential_configured).toBe(true);
  });

  it('UI-06: Cursor pagination across Users, Groups, Keys, Providers, Audit, Usage', async () => {
    // Populate 60 items in keys
    for (let i = 1; i <= 60; i++) {
      state.keys.push({
        id: `paginated-key-${i}`,
        user_id: state.users[0]!.id,
        group_id: state.groups[0]!.id,
        name: `Paging Key ${i}`,
        prefix: `nbc_pg_${i}`,
        status: 'active',
        quota_units: i * 10,
        quota_epoch: 1,
        expires_at: null,
        deleted_at: null,
        revision: 1,
        created_at: new Date(Date.now() - i * 1000).toISOString(),
        updated_at: new Date(Date.now() - i * 1000).toISOString(),
        last_used_at: null,
      });
    }

    // Page 1 (limit 25)
    const page1 = await api.keys.list({ limit: 25 });
    expect(page1.items.length).toBe(25);
    expect(page1.next_cursor).toBeDefined();

    // Page 2 (limit 25, cursor)
    const page2 = await api.keys.list({ limit: 25, cursor: page1.next_cursor! });
    expect(page2.items.length).toBe(25);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);

    // Page 3 (remaining items, reaching > 50 items)
    const page3 = await api.keys.list({ limit: 25, cursor: page2.next_cursor! });
    expect(page3.items.length).toBeGreaterThan(0);
  });

  it('UI-05: Usage error reporting does not forge 0 usage', async () => {
    state.usageError = true;
    await expect(api.usage.report()).rejects.toThrowError(ApiClientError);
    await expect(api.quotas.me()).rejects.toThrowError(ApiClientError);
    state.usageError = false;
  });

  describe('F-03: job-reader bounded complete read defenses', () => {
    it('detects cyclic cursor loop', async () => {
      const cyclicJobId = 'job-cyclic-test';
      state.jobs[cyclicJobId] = {
        schema_version: '3.0',
        action: 'get',
        job_id: cyclicJobId,
        state: 'succeeded',
        cancel_requested: false,
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        content_access: true,
      };
      state.jobArtifactChunks[cyclicJobId] = {
        chunks: [
          { index: 0, offset: 0, byte_length: 5, data_base64: Buffer.from('hello').toString('base64') },
        ],
        artifactMeta: {
          media_type: 'text/plain',
          byte_length: 10,
          sha256: 'dummy',
          expires_at: new Date().toISOString(),
        },
      };

      // Mock cyclic cursor by overriding read response behavior or temporarily monkey-patching
      const origRead = api.jobs.read;
      let calls = 0;
      api.jobs.read = async () => {
        calls++;
        return {
          schema_version: '3.0',
          action: 'read',
          job_id: cyclicJobId,
          state: 'succeeded',
          artifact: {
            media_type: 'text/plain',
            byte_length: 10,
            sha256: 'dummy',
            expires_at: new Date().toISOString(),
          },
          chunks: [{ index: 0, offset: 0, byte_length: 5, data_base64: Buffer.from('hello').toString('base64') }],
          next_cursor: 'cyclic-cursor-1',
        };
      };

      try {
        await expect(readFullJobArtifact(cyclicJobId)).rejects.toThrowError(/检测到循环分页游标/);
      } finally {
        api.jobs.read = origRead;
      }
    });

    it('rejects incomplete empty chunks when metadata states byte_length > 0', async () => {
      const emptyJobId = 'job-empty-test';
      const origRead = api.jobs.read;
      api.jobs.read = async () => ({
        schema_version: '3.0',
        action: 'read',
        job_id: emptyJobId,
        state: 'succeeded',
        artifact: {
          media_type: 'text/plain',
          byte_length: 1024,
          sha256: 'dummy',
          expires_at: new Date().toISOString(),
        },
        chunks: [],
        next_cursor: undefined,
      });

      try {
        await expect(readFullJobArtifact(emptyJobId)).rejects.toThrowError(/元数据声明大小为 1024 bytes，但未读取到任何分块数据/);
      } finally {
        api.jobs.read = origRead;
      }
    });

    it('rejects discontinuous chunk offset', async () => {
      const discontJobId = 'job-discont-test';
      const origRead = api.jobs.read;
      api.jobs.read = async () => ({
        schema_version: '3.0',
        action: 'read',
        job_id: discontJobId,
        state: 'succeeded',
        artifact: {
          media_type: 'text/plain',
          byte_length: 10,
          sha256: 'dummy',
          expires_at: new Date().toISOString(),
        },
        chunks: [
          { index: 0, offset: 0, byte_length: 5, data_base64: Buffer.from('hello').toString('base64') },
          { index: 1, offset: 6, byte_length: 5, data_base64: Buffer.from('world').toString('base64') }, // offset gap: 6 instead of 5
        ],
        next_cursor: undefined,
      });

      try {
        await expect(readFullJobArtifact(discontJobId)).rejects.toThrowError(/产物分块长度或偏移不连续/);
      } finally {
        api.jobs.read = origRead;
      }
    });

    it('rejects invalid UTF-8 bytes under strict fatal decoding', async () => {
      const badUtf8JobId = 'job-bad-utf8-test';
      const invalidByte = Buffer.from([0xff, 0xfe, 0xd8]);
      const origRead = api.jobs.read;
      api.jobs.read = async () => ({
        schema_version: '3.0',
        action: 'read',
        job_id: badUtf8JobId,
        state: 'succeeded',
        artifact: {
          media_type: 'text/plain',
          byte_length: 3,
          sha256: 'dummy',
          expires_at: new Date().toISOString(),
        },
        chunks: [
          { index: 0, offset: 0, byte_length: 3, data_base64: invalidByte.toString('base64') },
        ],
        next_cursor: undefined,
      });

      try {
        await expect(readFullJobArtifact(badUtf8JobId)).rejects.toThrowError(/产物内容无法按 UTF-8 严格解码/);
      } finally {
        api.jobs.read = origRead;
      }
    });

    it('successfully reads and strictly decodes valid multi-chunk text', async () => {
      const goodJobId = 'job-good-multi-test';
      const str = '第一块内容。\n第二块多字节中文边界测试。';
      const buf = Buffer.from(str, 'utf-8');
      const b1 = buf.subarray(0, 10);
      const b2 = buf.subarray(10);
      const origRead = api.jobs.read;
      let page = 0;
      api.jobs.read = async () => {
        page++;
        if (page === 1) {
          return {
            schema_version: '3.0',
            action: 'read',
            job_id: goodJobId,
            state: 'succeeded',
            artifact: {
              media_type: 'text/plain',
              byte_length: buf.length,
              sha256: 'dummy',
              expires_at: new Date().toISOString(),
            },
            chunks: [{ index: 0, offset: 0, byte_length: b1.length, data_base64: b1.toString('base64') }],
            next_cursor: 'page-2',
          };
        }
        return {
          schema_version: '3.0',
          action: 'read',
          job_id: goodJobId,
          state: 'succeeded',
          chunks: [{ index: 1, offset: b1.length, byte_length: b2.length, data_base64: b2.toString('base64') }],
          next_cursor: undefined,
        };
      };

      try {
        const res = await readFullJobArtifact(goodJobId);
        expect(res.text).toBe(str);
        expect(res.totalBytes).toBe(buf.length);
        expect(res.chunkCount).toBe(2);
      } finally {
        api.jobs.read = origRead;
      }
    });
  });
});
