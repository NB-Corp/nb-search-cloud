import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHiddenTwice, type HiddenInput } from '../../src/cli/password-input.js';
import { assertOwned, stopTestDatabase } from '../../scripts/test-database-control.mjs';

class ControlledTTY extends PassThrough {
  isTTY = true; isRaw = false; modes: boolean[] = [];
  setRawMode(value: boolean) { this.isRaw = value; this.modes.push(value); return this; }
}
function terminal(previousRaw = false) {
  const input = new ControlledTTY(); input.isRaw = previousRaw;
  const output: string[] = [];
  const result = readHiddenTwice(input as unknown as HiddenInput, { write: (value: string | Uint8Array) => { output.push(String(value)); return true; } });
  return { input, output, result };
}
describe('A-CLI01 controlled real control-character input', () => {
  it('accepts CR/LF confirmation, handles BS/DEL and split UTF8, never echoes the password', async () => {
    const t = terminal();
    t.input.write('Fake-pass-x\u007f');
    const unicode = Buffer.from('密'); t.input.write(unicode.subarray(0, 1)); t.input.write(unicode.subarray(1));
    t.input.write('\bword-123\r\nFake-pass-word-123\n');
    await expect(t.result).resolves.toBe('Fake-pass-word-123');
    expect(t.input.modes).toEqual([true, false]); expect(t.input.isPaused()).toBe(true);
    expect(t.output.join('')).toBe('Password: \nPassword again: \n');
    expect(t.input.listenerCount('data')).toBe(0); t.input.destroy();
  });
  it('cancels on actual Ctrl-C and restores a previously raw terminal', async () => {
    const t = terminal(true); t.input.write('never-echo\u0003');
    await expect(t.result).rejects.toThrow('Interrupted.');
    expect(t.input.modes).toEqual([true, true]); expect(t.output.join('')).not.toContain('never-echo'); t.input.destroy();
  });
  it('restores raw mode on mismatch and premature EOF', async () => {
    const t = terminal(); t.input.write('first-password\rsecond-password\r');
    await expect(t.result).rejects.toThrow('Passwords do not match.'); expect(t.input.isRaw).toBe(false); t.input.destroy();
    const eof = terminal(); eof.input.end('no-confirmation');
    await expect(eof.result).rejects.toThrow('Password input ended before confirmation.'); expect(eof.input.isRaw).toBe(false);
  });
});
describe('A-OPS01 exact container identity gate', () => {
  it('refuses stale state with identical names/labels and sends no removal/down command', async () => {
    const rootBase = resolve('.tmp'); await mkdir(rootBase, { recursive: true }); const root = await mkdtemp(resolve(rootBase, 'ops-test-'));
    const options = { root, name: 'same-name', project: 'ops-fixture' };
    const state = { version: 1, container_id: 'a'.repeat(64), nonce: 'c'.repeat(32), project: options.project };
    const replacement = { Id: 'b'.repeat(64), Config: { Labels: { 'nbcloud.test.owner': state.nonce, 'nbcloud.test.project': options.project } } };
    const commands: string[] = [];
    try {
      await mkdir(resolve(root, '.tmp')); await writeFile(resolve(root, '.tmp', `${options.project}.state.json`), JSON.stringify(state));
      expect(() => assertOwned(state, replacement, options)).toThrow('OWNERSHIP_MISMATCH');
      await expect(stopTestDatabase(options, { inspect: async () => replacement, remove: async (id: string) => { commands.push(id); } })).rejects.toThrow('OWNERSHIP_MISMATCH');
      expect(commands).toEqual([]);
      const actual = { ...replacement, Id: state.container_id };
      await stopTestDatabase(options, { inspect: async () => actual, remove: async (id: string) => { commands.push(id); } });
      expect(commands).toEqual([state.container_id]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
