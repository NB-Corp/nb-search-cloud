import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialFixture } from './test/mock-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const state = createInitialFixture();

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Handle /api/* requests with our complete mock backend
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      let parsed: any = {};
      try {
        if (body) parsed = JSON.parse(body);
      } catch {}

      const send = (data: any, code = 200) => {
        res.writeHead(code);
        res.end(JSON.stringify({ data, request_id: 'req_' + Math.random().toString(36).slice(2, 8) }));
      };

      const sendErr = (code: string, message: string, status = 400) => {
        res.writeHead(status);
        res.end(JSON.stringify({ error: { code, message }, request_id: 'req_err' }));
      };

      if (pathname === '/api/admin/auth/session') {
        const cookie = req.headers.cookie || '';
        if (cookie.includes('unauth=true')) {
          sendErr('AUTH_REQUIRED', '会话不存在', 401);
          return;
        }
        if (cookie.includes('role=user')) {
          const userSession = {
            ...state.currentSession,
            user: state.users[1],
          };
          send(userSession);
          return;
        }
        send(state.currentSession);
        return;
      }

      if (pathname === '/api/admin/auth/login' && req.method === 'POST') {
        const { username } = parsed;
        const u = state.users.find((user) => user.username === username) || state.users[0];
        state.currentSession = {
          tenant: { id: '00000000-0000-4000-8000-000000000000', slug: 'default', name: '默认组织' },
          user: u,
          csrf_token: 'csrf_' + Math.random().toString(36).slice(2),
          expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        };
        send(state.currentSession);
        return;
      }

      if (pathname === '/api/admin/keys') {
        send({ items: state.keys });
        return;
      }

      if (pathname === '/api/admin/groups') {
        send({ items: state.groups });
        return;
      }

      if (pathname === '/api/admin/me/available-groups') {
        send(state.groups.filter((g) => g.status === 'active'));
        return;
      }

      if (pathname === '/api/admin/users') {
        send({ items: state.users });
        return;
      }

      if (pathname === '/api/admin/providers') {
        send({ items: state.providers });
        return;
      }

      if (pathname === '/api/admin/providers/catalog') {
        send({
          operations: [
            { provider_id: 'exa', operation_id: 'search', kind: 'search' },
            { provider_id: 'exa', operation_id: 'contents', kind: 'fetch' },
            { provider_id: 'grok-multi-agent', operation_id: 'research', kind: 'search' },
          ],
          provider_options: {},
          credential_write_only: true,
        });
        return;
      }

      if (pathname === '/api/admin/lanes') {
        send({ items: state.lanes });
        return;
      }

      if (pathname === '/api/admin/me/quotas') {
        send({ items: state.quotas });
        return;
      }

      if (pathname === '/api/admin/usage') {
        send(state.usage);
        return;
      }

      if (pathname === '/api/admin/audit') {
        send({ items: state.audit });
        return;
      }

      sendErr('NOT_FOUND', 'Not found', 404);
    });
    return;
  }

  // Serve static dist files
  let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const PORT = 41731;
server.listen(PORT, () => {
  console.log(`Preview server running at http://127.0.0.1:${PORT}`);
});
