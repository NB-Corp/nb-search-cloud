import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

const assetName = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css|svg|png|jpg|jpeg|webp|gif|ico|woff|woff2|ttf)$/;
async function regularFile(path: string): Promise<boolean> {
  try { const stat = await lstat(path); return stat.isFile() && !stat.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Trusted build directory only; no SPA fallback and no user-controlled filesystem paths. */
export async function registerConsole(app: FastifyInstance, root = resolve(import.meta.dirname, '../web/dist')): Promise<boolean> {
  let directory;
  try { directory = await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink() || !await regularFile(resolve(root, 'index.html'))) return false;
  const files = ['index.html'];
  if (await regularFile(resolve(root, 'favicon.svg'))) files.push('favicon.svg');
  try {
    const assets = await lstat(resolve(root, 'assets'));
    if (assets.isDirectory() && !assets.isSymbolicLink()) for (const entry of await readdir(resolve(root, 'assets'), { withFileTypes: true })) {
      if (entry.isFile() && assetName.test(entry.name)) files.push(`assets/${entry.name}`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  app.register(async (scope) => {
    await scope.register(fastifyStatic, { root, serve: false, dotfiles: 'deny', index: false, cacheControl: false, etag: false, lastModified: false });
    for (const file of files) scope.get(file === 'index.html' ? '/' : `/${file}`, async (_request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      return reply.sendFile(file);
    });
  });
  return true;
}
