import { StringDecoder } from 'node:string_decoder';
import type { ReadStream } from 'node:tty';
import type { Writable } from 'node:stream';

export type HiddenInput = Pick<ReadStream, 'isTTY' | 'isRaw' | 'readableFlowing' | 'setRawMode' | 'pause' | 'resume' | 'on' | 'off'>;
export function readHiddenTwice(input: HiddenInput = process.stdin, output: Pick<Writable, 'write'> = process.stdout): Promise<string> {
  if (!input.isTTY) return Promise.reject(new Error('A terminal is required.'));
  return new Promise((resolve, reject) => {
    const previousRaw = input.isRaw ?? false;
    const previouslyFlowing = input.readableFlowing === true;
    const decoder = new StringDecoder('utf8');
    let first: string | undefined;
    let characters: string[] = [];
    let skipLf = false;
    let finished = false;
    const finish = (error?: Error, result?: string) => {
      if (finished) return; finished = true;
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      try { input.setRawMode(previousRaw); } catch { error = new Error('Could not restore terminal mode.'); }
      if (!previouslyFlowing) input.pause();
      output.write('\n');
      characters = [];
      first = undefined;
      if (error) reject(error); else resolve(result!);
    };
    const onEnd = () => finish(new Error('Password input ended before confirmation.'));
    const onError = () => finish(new Error('Password input failed.'));
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const char of text) {
        if (char === '\u0003') return finish(new Error('Interrupted.'));
        if (skipLf) { skipLf = false; if (char === '\n') continue; }
        if (char === '\r' || char === '\n') {
          skipLf = char === '\r';
          const value = characters.join(''); characters = [];
          if (first === undefined) { first = value; output.write('\nPassword again: '); }
          else return value === first ? finish(undefined, value) : finish(new Error('Passwords do not match.'));
        } else if (char === '\u007f' || char === '\b') characters.pop();
        else {
          if (Buffer.byteLength(characters.join('') + char, 'utf8') > 512) return finish(new Error('Password exceeds the allowed size.'));
          characters.push(char);
        }
      }
    };
    try {
      input.on('data', onData); input.on('end', onEnd); input.on('error', onError);
      input.setRawMode(true); output.write('Password: '); input.resume();
    } catch { finish(new Error('Password input failed.')); }
  });
}
export async function readAdminPassword(): Promise<string> {
  if (process.stdin.isTTY) return readHiddenTwice();
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if ((size += bytes.length) > 514) throw new Error('Password exceeds the allowed size.');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
  if (Buffer.byteLength(text) > 512) throw new Error('Password exceeds the allowed size.');
  return text;
}
