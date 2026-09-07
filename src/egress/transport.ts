import { Agent, request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { isIP, type LookupFunction } from 'node:net';
import type { HttpRequest, HttpResponse, HttpTransport } from '@nb-corp/nb-search';
import { ResponseLimitError } from '@nb-corp/nb-search';
import { EgressError, hostname, publicUrl, resolvePinned, sameAddress, systemResolver, type Resolver } from './address.js';

export interface PinnedRequest {
  url: URL; address: string; family: 4 | 6; body: Buffer; headers: Record<string, string>;
  signal: AbortSignal; maximum: number;
}
export interface PinnedResponse { status: number; headers: Record<string, string>; bytes: Buffer }
export interface PinnedIo { request(input: PinnedRequest): Promise<PinnedResponse> }

/** Low-level connector takes an already-validated numeric address, never an untrusted DNS policy. */
export class NodePinnedIo implements PinnedIo {
  /** Trusted host CA seam, never populated from request/provider configuration. TLS verification remains mandatory. */
  constructor(private readonly ca?: string | Buffer) {}
  async request(input: PinnedRequest): Promise<PinnedResponse> {
    if (input.signal.aborted) throw new EgressError('ABORTED');
    const host = hostname(input.url);
    const pinnedLookup: LookupFunction = (_name, options, callback) => {
      if (_name.replace(/\.$/, '').toLowerCase() !== host) { callback(new EgressError('TARGET_DENIED'), '', 0); return; }
      if ((options as { all?: boolean }).all) callback(null, [{ address: input.address, family: input.family }]);
      else callback(null, input.address, input.family);
    };
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0, proxyEnv: {} });
    try {
      return await new Promise<PinnedResponse>((resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, result?: PinnedResponse) => {
          if (settled) return; settled = true;
          input.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result!);
        };
        const options: import('node:https').RequestOptions & { autoSelectFamily: false } = {
          protocol: 'https:', hostname: host, port: input.url.port || 443, path: input.url.pathname + input.url.search,
          method: 'POST', headers: { ...input.headers, Host: input.url.host, 'Content-Length': String(input.body.length), 'Accept-Encoding': 'identity' },
          agent, lookup: pinnedLookup, family: input.family, autoSelectFamily: false,
          ...(isIP(host) ? { servername: '' } : { servername: host }), rejectUnauthorized: true, checkServerIdentity: (_hostname, cert) => checkServerIdentity(host, cert),
          maxHeaderSize: 16 * 1024, ...(this.ca === undefined ? {} : { ca: this.ca }),
        };
        const req = httpsRequest(options, (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) { response.destroy(); finish(new EgressError('REDIRECT_REJECTED')); return; }
          const encoding = response.headers['content-encoding'];
          if (encoding !== undefined && encoding.toLowerCase() !== 'identity') { response.destroy(); finish(new EgressError('RESPONSE_ENCODING')); return; }
          const declared = response.headers['content-length'];
          if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > input.maximum)) { response.destroy(); finish(new ResponseLimitError(input.maximum)); return; }
          const chunks: Buffer[] = []; let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > input.maximum) { finish(new ResponseLimitError(input.maximum)); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('error', () => finish(new EgressError('CONNECTION_FAILED')));
          response.on('aborted', () => finish(new EgressError('CONNECTION_FAILED')));
          response.on('end', () => {
            const headers: Record<string, string> = {};
            // Response metadata, never Set-Cookie or credential-bearing arbitrary headers.
            for (const key of ['content-type', 'retry-after']) { const value = response.headers[key]; if (typeof value === 'string') headers[key] = value; }
            finish(undefined, { status, headers, bytes: Buffer.concat(chunks, length) });
          });
        });
        const abort = () => { finish(new EgressError('ABORTED')); req.destroy(); };
        input.signal.addEventListener('abort', abort, { once: true });
        req.on('socket', (socket) => {
          socket.once('secureConnect', () => {
            if (input.signal.aborted) { abort(); return; }
            if (!socket.remoteAddress || !sameAddress(socket.remoteAddress, input.address)) { req.destroy(); finish(new EgressError('TARGET_DENIED')); return; }
            // No HTTP headers or credential/body writes before verified TLS and the pinned peer check.
            req.end(input.body);
          });
        });
        req.on('error', () => finish(new EgressError('TLS_FAILED')));
        if (input.signal.aborted) abort();
      });
    } finally { agent.destroy(); }
  }
}

export interface TransportPolicy { endpoints: readonly string[]; maxRequests: number; deadlineMs: number }
const allowedHeaders = new Set(['content-type', 'accept', 'authorization', 'x-api-key', 'anthropic-version']);
export class CloudPinnedHttpTransport implements HttpTransport {
  private readonly endpoints: Set<string>;
  private requests = 0;
  private readonly deadline: AbortSignal;
  private violation: string | undefined;
  constructor(policy: TransportPolicy, private readonly io: PinnedIo = new NodePinnedIo(), private readonly resolver: Resolver = systemResolver) {
    if (!Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1 || policy.maxRequests > 64 || !Number.isInteger(policy.deadlineMs) || policy.deadlineMs < 100 || policy.deadlineMs > 120_000) throw new EgressError('REQUEST_LIMIT');
    this.policy = policy;
    this.endpoints = new Set(policy.endpoints.map((raw) => { const url = publicUrl(raw); if (url.search) throw new EgressError('TARGET_DENIED'); return url.toString(); }));
    this.deadline = AbortSignal.timeout(policy.deadlineMs);
  }
  private readonly policy: TransportPolicy;
  get policyFailure(): string | undefined { return this.violation; }
  async send<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    try {
      const url = publicUrl(request.url);
      if (url.search || !this.endpoints.has(url.toString()) || request.method !== 'POST' || ++this.requests > this.policy.maxRequests) throw new EgressError('TARGET_DENIED');
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers ?? {})) {
        const name = key.toLowerCase();
        if (!allowedHeaders.has(name) || /[\r\n\u0000]/.test(value) || Buffer.byteLength(value) > 8192) throw new EgressError('TARGET_DENIED');
        headers[name] = value;
      }
      const body = Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}), 'utf8');
      if (body.length > 1024 * 1024) throw new EgressError('REQUEST_LIMIT');
      const maximum = Math.min(request.max_response_bytes ?? 16_777_216, 16_777_216);
      if (!Number.isSafeInteger(maximum) || maximum < 1) throw new EgressError('REQUEST_LIMIT');
      const signal = AbortSignal.any([request.signal, this.deadline]);
      const pin = await resolvePinned(url, signal, this.resolver);
      const response = await this.io.request({ url, ...pin, body, headers, signal, maximum });
      if (signal.aborted) throw new EgressError('ABORTED');
      if (response.status >= 300 && response.status < 400) throw new EgressError('REDIRECT_REJECTED');
      if (response.bytes.length > maximum) throw new ResponseLimitError(maximum);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
      let result: unknown = text;
      if (request.response_type !== 'text') {
        try { result = text === '' ? {} : JSON.parse(text); }
        catch { if (response.status >= 200 && response.status < 300) throw new EgressError('RESPONSE_ENCODING'); result = {}; }
      }
      return { status: response.status, headers: response.headers, body: result as T };
    } catch (error) {
      if (error instanceof EgressError) { this.violation = error.reason; throw error; }
      if (error instanceof ResponseLimitError) throw error;
      this.violation = 'RESPONSE_ENCODING'; throw new EgressError('RESPONSE_ENCODING');
    }
  }
}
