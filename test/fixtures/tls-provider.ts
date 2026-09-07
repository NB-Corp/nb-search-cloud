import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { NodePinnedIo, type PinnedIo, type PinnedRequest } from '../../src/egress/transport.js';
import type { Resolver } from '../../src/egress/address.js';

export async function tlsProvider(redirectTarget = 'https://127.0.0.1/forbidden') {
  const dir = await mkdtemp(resolve(tmpdir(), 'nbcloud-task18-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=provider.example', '-addext', 'subjectAltName=DNS:provider.example', '-keyout', resolve(dir, 'key.pem'), '-out', resolve(dir, 'cert.pem')], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const cert = await readFile(resolve(dir, 'cert.pem'));
  const seen: { path: string; host: string | undefined; sni: string | false | undefined; body: any; headers: Record<string, unknown> }[] = [];
  let connections = 0, httpRequests = 0, httpBytes = 0;
  const server = createServer({ key: await readFile(resolve(dir, 'key.pem')), cert }, async (req, res) => {
    httpRequests++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    seen.push({ path: req.url!, host: req.headers.host, sni: (req.socket as TLSSocket).servername, body, headers: req.headers });
    const path = req.url!;
    if (path === '/hang') return;
    if (path === '/headers') { res.setHeader('x-large', 'x'.repeat(20_000)); res.end('{}'); return; }
    if (path === '/redirect-no-location') { res.statusCode = 302; res.end(); return; }
    if (path.startsWith('/redirect/')) { res.writeHead(Number(path.split('/').at(-1)), { location: redirectTarget }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    if (path === '/bad-utf8') { res.end(Buffer.from([0xc3, 0x28])); return; }
    if (path === '/gzip') { res.setHeader('content-encoding', 'gzip'); res.end('{}'); return; }
    if (path === '/partial-body') { res.write('{"partial":"'); return; }
    if (path === '/large') { res.end(JSON.stringify({ value: 'x'.repeat(16_777_216) })); return; }
    if (path === '/large-stream') { for (let n = 0; n < 257; n++) res.write(Buffer.alloc(65536, 120)); res.end(); return; }
    const query = String(body.query ?? body.messages?.at(-1)?.content ?? '');
    if (query.includes('hang-worker')) return;
    if (query.includes('reject-once')) { res.statusCode = 503; res.end('{}'); return; }
    const text = query.includes('large-output') ? 'e'.repeat(72_000) : 'Trusted local evidence. '.repeat(30);
    const result = { title: 'Source', url: 'https://source.example/document', text };
    if (path.endsWith('/search') || path.endsWith('/contents')) { res.end(JSON.stringify({ results: [result] })); return; }
    const research = { answer: text, results: [{ title: result.title, url: result.url, snippet: 'Evidence' }], claims: [{ text: 'Claim', confidence: 'high', evidence_strength: 'direct', evidence_urls: [result.url] }] };
    res.end(JSON.stringify(path.endsWith('/messages') ? { content: [{ type: 'text', text: JSON.stringify(research) }] } : { choices: [{ message: { content: JSON.stringify(research) } }] }));
  });
  server.on('connection', () => { connections++; }); server.on('tlsClientError', () => undefined);
  server.on('secureConnection', (socket) => { socket.on('data', (chunk) => { httpBytes += chunk.length; }); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const base = `https://provider.example:${port}`;
  const pins: PinnedRequest[] = [];
  const node = new NodePinnedIo(cert);
  // Task-only connector mapping: policy still classifies every public answer before this seam.
  // The real Node connector validates TLS hostname, certificate, and actual loopback peer.
  const io: PinnedIo = { request(input) {
    if (input.address !== '93.184.216.34' || input.url.port !== String(port)) throw new Error('FIXTURE_PIN_DENIED');
    pins.push(input);
    return node.request({ ...input, address: '127.0.0.1', family: 4 });
  } };
  const resolver: Resolver = async () => ['93.184.216.34'];
  return { base, port, cert, io, resolver, pins, seen, get connections() { return connections; }, get httpRequests() { return httpRequests; }, get httpBytes() { return httpBytes; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((ok) => server.close(() => ok())); await rm(dir, { recursive: true, force: true }); } };
}
