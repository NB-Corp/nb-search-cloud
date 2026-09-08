import { spawn } from 'node:child_process';
import { realpath, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(root, 'node_modules/@nb-corp/nb-search');
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const cli = await realpath(resolve(packageRoot, manifest.bin['nb-search']));
const child = spawn(process.execPath, [cli, '--profile', 'cloud', ...process.argv.slice(2)], {
  cwd: root,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NB_SEARCH_HOME: resolve(root, '.local/client-home') },
  stdio: 'inherit',
});
child.once('error', () => { console.error('LOCAL_CLIENT_START_FAILED'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
