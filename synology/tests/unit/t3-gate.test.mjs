import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const KEY = 'k'.repeat(64);
const TOKEN = 'session-token';

async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  s.close();
  return port;
}

// A fake T3 Code that echoes the headers it received, for HTTP and upgrades.
async function withGate(run) {
  const upstream = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  upstream.on('upgrade', (req, socket) => {
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nx-seen: ${JSON.stringify(req.headers)}\r\n\r\n`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 't3-gate-'));
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
  const port = await freePort();
  const gate = spawn(process.execPath, [new URL('../../runtime/t3-gate.mjs', import.meta.url).pathname], {
    env: {
      T3_GATE_LISTEN: `127.0.0.1:${port}`,
      T3_GATE_UPSTREAM: `127.0.0.1:${upstream.address().port}`,
      T3_GATE_KEY: KEY,
      T3_GATE_TOKEN_FILE: join(dir, 'token'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await once(gate.stdout, 'data');
    await run(port);
  } finally {
    gate.kill();
    upstream.close();
  }
}

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

test('t3-gate admits only the gateway key and swaps in the T3 session', async () => {
  await withGate(async (port) => {
    assert.equal((await get(port, '/api/auth/session')).status, 401);
    assert.equal((await get(port, '/', { 'x-synopkgland-t3-key': 'x'.repeat(64) })).status, 401);

    const health = await get(port, '/.well-known/t3/environment');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).authorization, undefined);

    const res = await get(port, '/api/auth/session', {
      'x-synopkgland-t3-key': KEY,
      authorization: 'Bearer from-browser',
      cookie: 't3_session_abc=stale; theme=dark',
    });
    assert.equal(res.status, 200);
    const seen = JSON.parse(res.body);
    assert.equal(seen.authorization, `Bearer ${TOKEN}`);
    assert.equal(seen['x-synopkgland-t3-key'], undefined);
    assert.equal(seen.cookie, 'theme=dark');
  });
});

test('t3-gate applies the same rules to WebSocket upgrades', async () => {
  await withGate(async (port) => {
    const upgrade = (headers) =>
      new Promise((resolve, reject) => {
        http.request({ host: '127.0.0.1', port, path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
          .on('upgrade', (res, socket) => { socket.destroy(); resolve(res); })
          .on('response', (res) => resolve(res))
          .on('error', reject)
          .end();
      });
    assert.equal((await upgrade({})).statusCode, 401);
    const res = await upgrade({ 'x-synopkgland-t3-key': KEY, cookie: 't3_session_x=1' });
    assert.equal(res.statusCode, 101);
    const seen = JSON.parse(res.headers['x-seen']);
    assert.equal(seen.authorization, `Bearer ${TOKEN}`);
    assert.equal(seen['x-synopkgland-t3-key'], undefined);
    assert.equal(seen.cookie, undefined);
  });
});
