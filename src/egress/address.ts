import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class EgressError extends Error {
  constructor(readonly reason: 'TARGET_DENIED' | 'DNS_FAILED' | 'ABORTED' | 'TLS_FAILED' | 'REDIRECT_REJECTED' | 'RESPONSE_ENCODING' | 'REQUEST_LIMIT' | 'CONNECTION_FAILED') { super('Provider network policy rejected the request.'); }
}
const blockedNames = new Set(['localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);
const deniedV4 = ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.88.99.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3','168.63.129.16/32'].map((value) => ipaddr.parseCIDR(value));
const deniedV6 = ['2001::/23','2001:db8::/32','2002::/16','3fff::/20'].map((value) => ipaddr.parseCIDR(value));
export function isPublicAddress(value: string): boolean {
  try {
    if (value.includes('%') || !isIP(value)) return false;
    const address = ipaddr.parse(value);
    if (address.kind() === 'ipv4') return address.range() === 'unicast' && !deniedV4.some((network) => address.match(network));
    const v6 = address as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress() || v6.range() !== 'unicast' || !v6.match(ipaddr.parseCIDR('2000::/3'))) return false;
    return !deniedV6.some((network) => v6.match(network));
  } catch { return false; }
}
export function sameAddress(a: string, b: string): boolean {
  try { return Buffer.from(ipaddr.parse(a).toByteArray()).equals(Buffer.from(ipaddr.parse(b).toByteArray())); } catch { return false; }
}
export function publicUrl(raw: string, httpsOnly = true): URL {
  try {
    if (raw.length > 4096 || raw !== raw.trim() || /[\u0000-\u0020\u007f\\]/u.test(raw)) throw new Error();
    const url = new URL(raw);
    if (!(httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) || url.username || url.password || url.hash) throw new Error();
    const host = hostname(url);
    if (!host || host.includes('%') || blockedNames.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host === 'local') throw new Error();
    if (isIP(host) && !isPublicAddress(host)) throw new Error();
    return url;
  } catch { throw new EgressError('TARGET_DENIED'); }
}
export function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(); }
export type Resolver = (hostname: string) => Promise<readonly string[]>;
export const systemResolver: Resolver = async (name) => (await lookup(name, { all: true, verbatim: true })).map((answer) => answer.address);
export async function resolvePinned(url: URL, signal: AbortSignal, resolver: Resolver = systemResolver): Promise<{ address: string; family: 4 | 6 }> {
  if (signal.aborted) throw new EgressError('ABORTED');
  const host = hostname(url);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const answers = isIP(host) ? [host] : await abortable(resolver(host), deadline).catch(() => { throw new EgressError(signal.aborted ? 'ABORTED' : 'DNS_FAILED'); });
  if (signal.aborted) throw new EgressError('ABORTED');
  if (!answers.length || answers.length > 64 || answers.some((address) => !isPublicAddress(address))) throw new EgressError('TARGET_DENIED');
  const address = answers[0]!;
  return { address, family: isIP(address) as 4 | 6 };
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new EgressError('ABORTED');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new EgressError('ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
  });
}
