import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Agent } from 'node:https';
import { createServer } from 'node:net';
import { CloudPinnedHttpTransport, NodePinnedIo } from '../../src/egress/transport.js';
import { isPublicAddress } from '../../src/egress/address.js';
import { tlsProvider } from '../fixtures/tls-provider.js';
let fixture: Awaited<ReturnType<typeof tlsProvider>>;
let redirectConnections = 0;
const redirectTrap = createServer((socket) => { redirectConnections++; socket.destroy(); });
beforeAll(async () => {
  await new Promise<void>((ok) => redirectTrap.listen(0, '127.0.0.1', ok));
  fixture = await tlsProvider(`https://127.0.0.1:${(redirectTrap.address() as { port: number }).port}/forbidden`);
});
afterAll(async () => { await fixture?.close(); await new Promise<void>((ok) => redirectTrap.close(() => ok())); });
function transport(path: string, resolver = fixture.resolver, deadlineMs = 3000) { return new CloudPinnedHttpTransport({ endpoints: [fixture.base + path], maxRequests: 4, deadlineMs }, fixture.io, resolver); }
function request(path: string, extra: Record<string, unknown> = {}) { return { url: fixture.base + path, method: 'POST' as const, signal: new AbortController().signal, body: {}, ...extra }; }
it('connects only to the selected numeric peer with verified cert/SNI/Host; never pools or uses environment proxies', async () => {
  const forbidden = createServer(); let connections = 0; forbidden.on('connection', (socket) => { connections++; socket.destroy(); });
  await new Promise<void>((ok) => forbidden.listen(0, '127.0.0.1', ok));
  const address = forbidden.address() as { port: number };
  const original = process.env['HTTPS_PROXY']; process.env['HTTPS_PROXY'] = `http://127.0.0.1:${address.port}`;
  try {
    const before = fixture.connections;
    const t = transport('/search');
    for (let n = 0; n < 2; n++) expect((await t.send(request('/search'))).status).toBe(200);
    expect(fixture.connections - before).toBe(2); expect(connections).toBe(0);
    expect(fixture.pins.at(-1)?.address).toBe('93.184.216.34');
    expect(fixture.seen.at(-1)).toMatchObject({ host: `provider.example:${fixture.port}`, sni: 'provider.example' });
  } finally { if (original === undefined) delete process.env['HTTPS_PROXY']; else process.env['HTTPS_PROXY'] = original; await new Promise<void>((ok) => forbidden.close(() => ok())); }
});
it('preserves streamed text, Accept and split UTF-8 through real pinned TLS without changing send()', async () => {
  const t = transport('/sse');
  const result = await t.send<string>(request('/sse', { response_type: 'text', max_response_bytes: 1024, redirect: 'manual', headers: { Accept: 'text/event-stream' }, body: { stream: true } }));
  expect(result).toEqual({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"text":"证据 🌍 café"}\n\ndata: [DONE]\n\n' });
  expect(fixture.seen.at(-1)).toMatchObject({ headers: { accept: 'text/event-stream' }, body: { stream: true } });
  await expect(transport('/sse').send(request('/sse', { response_type: 'text', max_response_bytes: 16 }))).rejects.toMatchObject({ name: 'ResponseLimitError' });
  await expect(transport('/sse-disconnect').send(request('/sse-disconnect', { response_type: 'text' }))).rejects.toMatchObject({ reason: 'CONNECTION_FAILED' });
});
it('rejects every prohibited DNS answer and special-address form before any connector or request', async () => {
  const before = fixture.connections, requests = fixture.seen.length, pins = fixture.pins.length;
  for (const bad of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '168.63.129.16', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:93.184.216.34', '0:0:0:0:0:ffff:7f00:1', '2001:db8::1', 'fe80::1%eth0', '64:ff9b::c000:201', '2002:c000:201::1', '2001::1', 'fec0::1', 'ff02::1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.18.0.1']) {
    expect(isPublicAddress(bad)).toBe(false);
    await expect(transport('/search', async () => ['93.184.216.34', bad]).send(request('/search'))).rejects.toThrow();
  }
  for (const target of ['https://metadata.google.internal/', 'https://metadata.google.internal./', 'https://%6detadata.google.internal/', 'https://foo.localhost/', 'https://[fe80::1%25eth0]/', 'https://127.1/', 'https://2130706433/', 'https://[::ffff:127.0.0.1]/', 'http://provider.example/']) {
    expect(() => new CloudPinnedHttpTransport({ endpoints: [target], maxRequests: 1, deadlineMs: 1000 }, fixture.io, fixture.resolver)).toThrow();
  }
  for (const resolver of [async () => [], async () => { throw new Error('fixture DNS failure'); }]) await expect(transport('/search', resolver).send(request('/search'))).rejects.toThrow();
  const abort = new AbortController(); let deliver!: (addresses: readonly string[]) => void;
  const pending = transport('/search', () => new Promise<readonly string[]>((resolve) => { deliver = resolve; })).send(request('/search', { signal: abort.signal }));
  abort.abort(); await expect(pending).rejects.toThrow(); deliver(['93.184.216.34']); await new Promise((resolve) => setImmediate(resolve));
  expect(fixture.connections).toBe(before); expect(fixture.seen).toHaveLength(requests); expect(fixture.pins).toHaveLength(pins);
});
it('re-resolves every request and refuses public-to-private DNS changes without fallback', async () => {
  let calls = 0;
  const t = transport('/search', async () => ++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
  await t.send(request('/search')); const before = fixture.connections;
  await expect(t.send(request('/search'))).rejects.toThrow(); expect(fixture.connections).toBe(before); expect(calls).toBe(2);
  let attempts = 0;
  const noFallback = new CloudPinnedHttpTransport({ endpoints: [fixture.base + '/search'], maxRequests: 1, deadlineMs: 1000 }, { request: async () => { attempts++; throw new Error('test connection failure'); } }, async () => ['93.184.216.34', '93.184.216.35']);
  await expect(noFallback.send(request('/search'))).rejects.toThrow(); expect(attempts).toBe(1);
});
it('rejects all 3xx without following Location, excessive headers/body, deadlines and cancellation', async () => {
  for (const code of [300,301,302,303,304,305,306,307,308,399]) {
    const path = `/redirect/${code}`, before = fixture.seen.length;
    await expect(transport(path).send(request(path))).rejects.toThrow(); expect(fixture.seen.length - before).toBe(1);
  }
  await expect(transport('/redirect-no-location').send(request('/redirect-no-location'))).rejects.toThrow(); expect(redirectConnections).toBe(0);
  await expect(transport('/headers').send(request('/headers'))).rejects.toThrow();
  await expect(transport('/large').send(request('/large'))).rejects.toMatchObject({ name: 'ResponseLimitError', maximum: 16_777_216 });
  await expect(transport('/large').send(request('/large', { max_response_bytes: 1_000_000_000 }))).rejects.toMatchObject({ name: 'ResponseLimitError', maximum: 16_777_216 });
  await expect(transport('/large-stream').send(request('/large-stream'))).rejects.toMatchObject({ name: 'ResponseLimitError', maximum: 16_777_216 });
  await expect(transport('/search').send(request('/search', { max_response_bytes: 5 }))).rejects.toThrow();
  await expect(transport('/hang', fixture.resolver, 100).send(request('/hang'))).rejects.toThrow();
  const abort = new AbortController(); const p = transport('/hang').send(request('/hang', { signal: abort.signal })); setTimeout(() => abort.abort(), 30); await expect(p).rejects.toThrow();
});
it('fails closed on untrusted CA or wrong certificate hostname before sending HTTP credentials', async () => {
  const before = fixture.seen.length;
  const input = { url: new URL(fixture.base + '/search'), address: '127.0.0.1', family: 4 as const, headers: { authorization: 'Bearer fixture-only' }, body: Buffer.from('{}'), signal: AbortSignal.timeout(2000), maximum: 1024 };
  await expect(new NodePinnedIo().request(input)).rejects.toThrow();
  await expect(new NodePinnedIo(fixture.cert).request({ ...input, url: new URL(`https://wrong.example:${fixture.port}/search`) })).rejects.toThrow();
  expect(fixture.seen).toHaveLength(before);
});
it('review evidence: real TLS peer mismatch sends zero HTTP bytes, headers or credentials', async () => {
  const original = Agent.prototype.createConnection;
  const spy = vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (this: Agent, ...args: any[]) {
    const socket = (original as any).apply(this, args);
    Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: '127.0.0.2' });
    return socket;
  });
  const before = { connections: fixture.connections, requests: fixture.httpRequests, bytes: fixture.httpBytes };
  try {
    await expect(new NodePinnedIo(fixture.cert).request({ url: new URL(fixture.base + '/search'), address: '127.0.0.1', family: 4, headers: { authorization: 'Bearer peer-mismatch-canary' }, body: Buffer.from('{"secret":"body-canary"}'), signal: AbortSignal.timeout(2000), maximum: 1024 })).rejects.toMatchObject({ reason: 'TARGET_DENIED' });
    expect(fixture.connections).toBe(before.connections + 1); expect(fixture.httpRequests).toBe(before.requests); expect(fixture.httpBytes).toBe(before.bytes);
  } finally { spy.mockRestore(); }
});
it.each(['/bad-utf8','/gzip'])('review evidence: rejects %s with a distinct completed-response policy oracle', async (path) => {
  const t = transport(path); const before = fixture.httpRequests;
  await expect(t.send(request(path))).rejects.toMatchObject({ reason: 'RESPONSE_ENCODING' });
  expect(fixture.httpRequests).toBe(before + 1); expect(t.policyFailure).toBe('RESPONSE_ENCODING');
});
it('review evidence: aborts after actual partial response bytes have arrived', async () => {
  const abort = new AbortController(); let receivedPartial = false;
  const original = Agent.prototype.createConnection;
  const spy = vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (this: Agent, ...args: any[]) {
    const socket = (original as any).apply(this, args);
    socket.on('data', (chunk: Buffer) => { if (chunk.toString().includes('{"partial":"')) { receivedPartial = true; queueMicrotask(() => abort.abort()); } });
    return socket;
  });
  try {
    const t = transport('/partial-body');
    await expect(t.send(request('/partial-body', { signal: abort.signal }))).rejects.toMatchObject({ reason: 'ABORTED' });
    expect(receivedPartial).toBe(true); expect(t.policyFailure).toBe('ABORTED');
  } finally { spy.mockRestore(); }
});
