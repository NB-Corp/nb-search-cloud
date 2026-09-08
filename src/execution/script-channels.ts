import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { appError } from '../errors.js';
import { publicUrl } from '../egress/address.js';
const params = z.record(z.string(), z.json());
const manifestSchema = z.object({ channels: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/), label: z.string().min(1).max(100), module: z.string().min(1), params: params.default({}), endpoints: z.array(z.string().url()).default([]) }).strict()) }).strict();
export class ScriptChannels {
  private readonly channels: Map<string, { id: string; label: string; module: string; params: Record<string, unknown>; endpoints: string[] }>;
  constructor(path?: string) {
    this.channels = new Map();
    if (!path) return;
    try {
      const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      for (const entry of manifest.channels) {
        if (this.channels.has(entry.id)) throw Error();
        const module = resolve(dirname(path), entry.module);
        if (!statSync(module).isFile() || !/\.(?:m?js|m?ts)$/.test(module)) throw Error();
        entry.endpoints.forEach(url => publicUrl(url));
        this.channels.set(entry.id, { ...entry, module });
      }
    } catch { throw Error('SCRIPT_CHANNEL_MANIFEST_INVALID'); }
  }
  list() { return [...this.channels.values()].map(({ id, label }) => ({ id, label })); }
  get(id: unknown) {
    const channel = typeof id === 'string' ? this.channels.get(id) : undefined;
    if (!channel) throw appError('VALIDATION_FAILED');
    return channel;
  }
  options(input: unknown): Record<string, unknown> {
    const parsed = z.object({ channel_id: z.string(), params: params.default({}) }).strict().safeParse(input);
    if (!parsed.success) throw appError('VALIDATION_FAILED');
    this.get(parsed.data.channel_id);
    return parsed.data;
  }
  /** Operator-only path resolution; tenant options cannot override module or transport endpoints. */
  resolve(input: Record<string, unknown>) {
    const options = this.options(input), channel = this.get(options['channel_id']);
    return { options: { module: channel.module, params: { ...channel.params, ...(options['params'] as Record<string, unknown>) } }, endpoints: channel.endpoints };
  }
}
