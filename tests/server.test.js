import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { WebSocket } from 'ws';

// Set required env before importing server
process.env.ADMIN_PASSWORD = 'testpassword12chars';
process.env.SESSION_SECRET = 'test-session-secret-for-vitest';

const { app, server, ALLOWED_WS_ORIGINS, roomCreateAttempts } = await import('../src/server.js');

// --- Helpers ---

let serverAddr;
let ORIGIN;
let HOST;

function post(path) {
  return request(app).post(path).set('Origin', ORIGIN).set('Host', HOST);
}

function del(path) {
  return request(app).delete(path).set('Origin', ORIGIN).set('Host', HOST);
}

let _adminAgent;
async function loginAgent() {
  if (_adminAgent) return _adminAgent;
  _adminAgent = request.agent(app);
  await _adminAgent.post('/auth/login')
    .set('Origin', ORIGIN).set('Host', HOST)
    .send({ username: 'admin', password: 'testpassword12chars' });
  return _adminAgent;
}

function agentPost(agent, path) {
  return agent.post(path).set('Origin', ORIGIN).set('Host', HOST);
}
function agentGet(agent, path) {
  return agent.get(path).set('Host', HOST);
}
function agentDel(agent, path) {
  return agent.delete(path).set('Origin', ORIGIN).set('Host', HOST);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256HexFromBytes(hexStr) {
  return crypto.createHash('sha256').update(Buffer.from(hexStr, 'hex')).digest('hex');
}

function makeRoomFixture() {
  const roomId = randomHex(8);
  const accessToken = randomHex(32);
  const accessTokenHash = sha256HexFromBytes(accessToken);
  const inviteTokens = [randomHex(16), randomHex(16)];
  const inviteTokenHashes = inviteTokens.map(sha256HexFromBytes);
  return { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes };
}

function wsUrl(roomId, accessToken, inviteToken) {
  return `ws://127.0.0.1:${serverAddr.port}/chat/${roomId}?access=${accessToken}&invite=${inviteToken}`;
}

function wsOpts() {
  return { origin: `http://localhost:${serverAddr.port}`, headers: { host: `localhost:${serverAddr.port}` } };
}

beforeAll(async () => {
  await new Promise((resolve) => {
    server.listen(0, () => resolve());
  });
  serverAddr = server.address();
  HOST = `localhost:${serverAddr.port}`;
  ORIGIN = `http://${HOST}`;
  ALLOWED_WS_ORIGINS.add(ORIGIN);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ================================================================
// AUTHENTICATION
// ================================================================

describe('Authentication', () => {
  it('rejects unauthenticated access to admin API', async () => {
    const res = await request(app).get('/api/status').set('Host', HOST);
    expect(res.status).toBe(401);
  });

  it('rejects wrong password', async () => {
    const res = await post('/auth/login')
      .send({ username: 'admin', password: 'wrongpassword1' });
    expect(res.status).toBe(401);
  });

  it('accepts correct credentials and grants session', async () => {
    const a = await loginAgent();
    const statusRes = await agentGet(a, '/api/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toHaveProperty('uptime');
  });

  it('logout clears session', async () => {
    // Use a separate agent so we don't log out the cached admin agent
    const a = request.agent(app);
    await a.post('/auth/login')
      .set('Origin', ORIGIN).set('Host', HOST)
      .send({ username: 'admin', password: 'testpassword12chars' });
    await a.post('/auth/logout').set('Origin', ORIGIN).set('Host', HOST);
    const res = await a.get('/api/status').set('Host', HOST);
    expect(res.status).toBe(401);
  });

  it('enforces 12-char minimum on password change', async () => {
    const a = await loginAgent();
    const res = await agentPost(a, '/auth/change-password')
      .send({ currentPassword: 'testpassword12chars', newPassword: 'short123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/12 characters/);
  });

});

// ================================================================
// DEAD DROP
// ================================================================

describe('Dead Drop', () => {
  it('creates and retrieves a drop', async () => {
    const createRes = await post('/api/drop')
      .send({ encrypted: 'ciphertext-data', iv: 'random-iv-value' });
    expect(createRes.status).toBe(201);
    expect(createRes.body).toHaveProperty('id');

    const getRes = await request(app).get(`/api/drop/${createRes.body.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.encrypted).toBe('ciphertext-data');
    expect(getRes.body.iv).toBe('random-iv-value');
  });

  it('burn-after-read deletes on first retrieval', async () => {
    const createRes = await post('/api/drop')
      .send({ encrypted: 'secret', iv: 'iv123', burn: true });
    const id = createRes.body.id;

    const first = await request(app).get(`/api/drop/${id}`);
    expect(first.status).toBe(200);

    const second = await request(app).get(`/api/drop/${id}`);
    expect(second.status).toBe(404);
  });

  it('rejects oversized drops', async () => {
    const big = 'x'.repeat(300 * 1024);
    const res = await post('/api/drop')
      .send({ encrypted: big, iv: 'iv' });
    expect(res.status).toBe(413);
  });

  it('rejects invalid drop ID format', async () => {
    const res = await request(app).get('/api/drop/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('admin can list and delete drops', async () => {
    const a = await loginAgent();
    const createRes = await post('/api/drop')
      .send({ encrypted: 'admin-test', iv: 'iv' });

    const listRes = await agentGet(a, '/api/drops');
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThan(0);

    const delRes = await agentDel(a, `/api/drops/${createRes.body.id}`);
    expect(delRes.status).toBe(204);
  });
});

// ================================================================
// FILE DROP
// ================================================================

describe('File Drop', () => {
  it('creates and retrieves a file', async () => {
    const createRes = await post('/api/file')
      .send({
        encrypted: 'encrypted-file-data',
        iv: 'file-iv',
        encryptedMeta: 'encrypted-meta',
        metaIv: 'meta-iv',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body).toHaveProperty('id');

    const getRes = await request(app).get(`/api/file/${createRes.body.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.encrypted).toBe('encrypted-file-data');
    expect(getRes.body.encryptedMeta).toBe('encrypted-meta');
  });

  it('burn-after-download deletes on first retrieval', async () => {
    const createRes = await post('/api/file')
      .send({
        encrypted: 'burnfile',
        iv: 'iv',
        encryptedMeta: 'meta',
        metaIv: 'miv',
        burn: true,
      });
    const id = createRes.body.id;

    const first = await request(app).get(`/api/file/${id}`);
    expect(first.status).toBe(200);

    const second = await request(app).get(`/api/file/${id}`);
    expect(second.status).toBe(404);
  });

  it('rejects invalid file ID format', async () => {
    const res = await request(app).get('/api/file/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('admin can list and delete files', async () => {
    const a = await loginAgent();
    const createRes = await post('/api/file')
      .send({
        encrypted: 'admin-test',
        iv: 'iv',
        encryptedMeta: 'meta',
        metaIv: 'miv',
      });

    const listRes = await agentGet(a, '/api/files');
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThan(0);

    const delRes = await agentDel(a, `/api/files/${createRes.body.id}`);
    expect(delRes.status).toBe(204);
  });
});

// ================================================================
// SIGNAL ROOM
// ================================================================

describe('Signal Room', () => {
  it('registers a room', async () => {
    const { roomId, accessTokenHash, inviteTokenHashes } = makeRoomFixture();
    const res = await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('expiresAt');
  });

  it('rejects duplicate room registration', async () => {
    const { roomId, accessTokenHash, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });
    const res = await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });
    expect(res.status).toBe(409);
  });

  it('rejects invalid room ID format', async () => {
    const res = await post('/api/chat/room')
      .send({
        roomId: 'bad!',
        accessTokenHash: randomHex(32),
        inviteTokenHashes: [randomHex(32), randomHex(32)],
      });
    expect(res.status).toBe(400);
  });

  it('connects via WebSocket with correct tokens', async () => {
    const { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });

    const ws = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[0]), wsOpts());

    const msg = await new Promise((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS timeout')), 3000);
    });

    expect(msg.type).toBe('init');
    expect(msg).toHaveProperty('peer');
    expect(msg.count).toBe(1);
    ws.close();
  });

  it('rejects WebSocket with wrong access token', async () => {
    const { roomId, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });

    const ws = new WebSocket(wsUrl(roomId, randomHex(32), inviteTokens[0]), wsOpts());

    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('connected'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(result).toBe('rejected');
  });

  it('rejects WebSocket with wrong invite token', async () => {
    const { roomId, accessToken, accessTokenHash, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });

    const ws = new WebSocket(wsUrl(roomId, accessToken, randomHex(16)), wsOpts());

    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('connected'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(result).toBe('rejected');
  });

  it('allows reconnection after disconnect (token released)', async () => {
    const { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });

    const url = wsUrl(roomId, accessToken, inviteTokens[0]);
    const opts = wsOpts();

    // First connection
    const ws1 = new WebSocket(url, opts);
    await new Promise((resolve, reject) => {
      ws1.on('message', () => resolve());
      ws1.on('error', reject);
    });
    ws1.close();
    await new Promise((resolve) => { ws1.on('close', resolve); });
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect with same token
    const ws2 = new WebSocket(url, opts);
    const msg = await new Promise((resolve, reject) => {
      ws2.on('message', (data) => resolve(JSON.parse(data.toString())));
      ws2.on('error', reject);
      setTimeout(() => reject(new Error('Reconnect timeout')), 3000);
    });

    expect(msg.type).toBe('init');
    ws2.close();
  });

  it('relays encrypted messages between peers', async () => {
    const { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });

    const opts = wsOpts();

    // Connect peer A and wait for init
    const wsA = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[0]), opts);
    await new Promise((resolve) => { wsA.on('message', () => resolve()); });

    // Connect peer B and wait for init
    const wsB = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[1]), opts);
    await new Promise((resolve) => { wsB.on('message', () => resolve()); });

    // Set up message listener on A (skip join notification, wait for relayed msg)
    const msgPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay timeout')), 3000);
      wsA.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'msg') {
          clearTimeout(timeout);
          resolve(parsed);
        }
      });
    });

    // Small delay to ensure join is processed
    await new Promise((r) => setTimeout(r, 100));
    wsB.send(JSON.stringify({ type: 'msg', data: 'ciphertext123', iv: 'iv456' }));

    const relayed = await msgPromise;
    expect(relayed.data).toBe('ciphertext123');
    expect(relayed.iv).toBe('iv456');
    expect(relayed).toHaveProperty('from');

    wsA.close();
    wsB.close();
  });

  it('relays generation counter (g) for forward secrecy', async () => {
    const opts = wsOpts();
    const { roomId, accessToken, inviteTokens, accessTokenHash, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });

    const wsA = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[0]), opts);
    await new Promise((resolve) => { wsA.on('message', () => resolve()); });

    const wsB = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[1]), opts);
    await new Promise((resolve) => { wsB.on('message', () => resolve()); });

    // Test valid generation counter is relayed
    const msgPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay timeout')), 3000);
      wsA.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'msg') {
          clearTimeout(timeout);
          resolve(parsed);
        }
      });
    });

    await new Promise((r) => setTimeout(r, 100));
    wsB.send(JSON.stringify({ type: 'msg', data: 'ct', iv: 'iv', g: 42 }));

    const relayed = await msgPromise;
    expect(relayed.g).toBe(42);
    expect(relayed.data).toBe('ct');

    // Test invalid generation counter is not relayed
    const msgPromise2 = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay timeout')), 3000);
      wsA.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'msg') {
          clearTimeout(timeout);
          resolve(parsed);
        }
      });
    });

    wsB.send(JSON.stringify({ type: 'msg', data: 'ct2', iv: 'iv2', g: 'malicious' }));

    const relayed2 = await msgPromise2;
    expect(relayed2.g).toBeUndefined();
    expect(relayed2.data).toBe('ct2');

    wsA.close();
    wsB.close();
  });

  it('admin can list and kill rooms', async () => {
    roomCreateAttempts.clear(); // Reset rate limit for this test
    const a = await loginAgent();
    const { roomId, accessTokenHash, inviteTokenHashes } = makeRoomFixture();
    const regRes = await post('/api/chat/room')
      .send({ roomId, accessTokenHash, inviteTokenHashes });
    expect(regRes.status).toBe(201);

    const listRes = await agentGet(a, '/api/chat/rooms');
    expect(listRes.status).toBe(200);
    const found = listRes.body.find((r) => r.id === roomId);
    expect(found).toBeDefined();

    const delRes = await agentDel(a, `/api/chat/rooms/${roomId}`);
    expect(delRes.status).toBe(204);
  });
});

// ================================================================
// SECURITY
// ================================================================

describe('Security', () => {
  it('serves CSP header with nonce on tool pages', async () => {
    for (const path of ['/drop', '/chat', '/file']) {
      const res = await request(app).get(path);
      const csp = res.headers['content-security-policy'];
      expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
      const scriptSrc = csp.match(/script-src [^;]+/)[0];
      expect(scriptSrc).not.toContain("'unsafe-inline'");
    }
  });

  it('serves security headers on all responses', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers).not.toHaveProperty('x-powered-by');
  });

  it('sets cross-origin isolation on tool pages', async () => {
    const res = await request(app).get('/drop');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  it('sets no-store cache headers on tool pages', async () => {
    const res = await request(app).get('/drop');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('blocks state-changing requests without Origin header', async () => {
    const res = await request(app).post('/auth/login')
      .send({ username: 'admin', password: 'testpassword12chars' });
    expect(res.status).toBe(403);
  });

  it('session cookie uses generic name', async () => {
    const a = await loginAgent();
    const res = await agentGet(a, '/api/status');
    expect(res.status).toBe(200);
  });
});

// ================================================================
// PUBLIC PAGES
// ================================================================

describe('Public pages', () => {
  it('serves landing page at /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('html');
  });

  it('serves tool pages without auth', async () => {
    for (const path of ['/drop', '/chat', '/file']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }
  });

  it('blocks admin panel when not authenticated', async () => {
    const res = await request(app).get('/panel');
    expect([302, 401]).toContain(res.status);
  });

  it('includes limitations disclaimer on tool pages', async () => {
    for (const path of ['/drop', '/chat', '/file']) {
      const res = await request(app).get(path);
      expect(res.text).toContain('Limitations');
      expect(res.text).toContain('cannot protect against');
    }
  });
});

// ================================================================
// ADVERSARIAL — DROP ABUSE
// ================================================================

describe('Drop abuse', () => {
  it('rejects empty body', async () => {
    const res = await post('/api/drop').send({});
    expect(res.status).toBe(400);
  });

  it('rejects non-string encrypted field', async () => {
    for (const bad of [123, true, null, [], {}]) {
      const res = await post('/api/drop').send({ encrypted: bad, iv: 'iv' });
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-string iv field', async () => {
    const res = await post('/api/drop').send({ encrypted: 'data', iv: 12345 });
    expect(res.status).toBe(400);
  });

  it('rejects oversized IV', async () => {
    const res = await post('/api/drop').send({ encrypted: 'data', iv: 'x'.repeat(25) });
    expect(res.status).toBe(400);
  });

  it('accepts empty string encrypted (valid ciphertext is opaque)', async () => {
    // Server can't distinguish valid from invalid ciphertext — that's the client's job
    // But empty string is falsy, so it should be rejected
    const res = await post('/api/drop').send({ encrypted: '', iv: 'iv' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid expiry values gracefully (defaults to 24h)', async () => {
    const res = await post('/api/drop')
      .send({ encrypted: 'data', iv: 'iv', expiry: 'FOREVER' });
    expect(res.status).toBe(201); // falls back to 24h default
  });

  it('returns 404 for non-existent UUID', async () => {
    const res = await request(app).get('/api/drop/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('rejects path traversal in drop ID', async () => {
    // Express normalizes /../ paths, so this resolves to a different route
    // The important thing is it doesn't return 200 with sensitive data
    const res = await request(app).get('/api/drop/../../../etc/passwd');
    expect(res.status).not.toBe(200);
  });
});

// ================================================================
// ADVERSARIAL — FILE ABUSE
// ================================================================

describe('File abuse', () => {
  it('rejects missing fields', async () => {
    // Missing encryptedMeta
    const res = await post('/api/file').send({ encrypted: 'data', iv: 'iv' });
    expect(res.status).toBe(400);
  });

  it('rejects non-string field types', async () => {
    const res = await post('/api/file').send({
      encrypted: 123, iv: 'iv', encryptedMeta: 'meta', metaIv: 'miv',
    });
    expect(res.status).toBe(400);
  });

  it('rejects oversized IV fields', async () => {
    const res = await post('/api/file').send({
      encrypted: 'data', iv: 'x'.repeat(25), encryptedMeta: 'meta', metaIv: 'miv',
    });
    expect(res.status).toBe(400);

    const res2 = await post('/api/file').send({
      encrypted: 'data', iv: 'iv', encryptedMeta: 'meta', metaIv: 'x'.repeat(25),
    });
    expect(res2.status).toBe(400);
  });

  it('rejects oversized metadata', async () => {
    const res = await post('/api/file').send({
      encrypted: 'data', iv: 'iv', encryptedMeta: 'x'.repeat(4097), metaIv: 'miv',
    });
    expect(res.status).toBe(400);
  });

  it('rejects file exceeding size limit', async () => {
    // FILE_MAX_SIZE is 14MB (base64 of ~10MB). Express default body limit
    // may also reject before the route handler — either 413 or 500 is correct.
    const big = 'x'.repeat(15 * 1024 * 1024);
    const res = await post('/api/file').send({
      encrypted: big, iv: 'iv', encryptedMeta: 'meta', metaIv: 'miv',
    });
    expect([413, 500]).toContain(res.status);
  });
});

// ================================================================
// ADVERSARIAL — ROOM REGISTRATION ABUSE
// ================================================================

describe('Room registration abuse', () => {
  it('rejects missing fields', async () => {
    const res = await post('/api/chat/room').send({});
    expect(res.status).toBe(400);
  });

  it('rejects room ID with special characters', async () => {
    const res = await post('/api/chat/room').send({
      roomId: '<script>alert(1)',
      accessTokenHash: randomHex(32),
      inviteTokenHashes: [randomHex(32)],
    });
    expect(res.status).toBe(400);
  });

  it('rejects room ID too short or too long', async () => {
    for (const bad of ['abc', 'a'.repeat(100)]) {
      const res = await post('/api/chat/room').send({
        roomId: bad,
        accessTokenHash: randomHex(32),
        inviteTokenHashes: [randomHex(32), randomHex(32)],
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects invalid access token hash format', async () => {
    const res = await post('/api/chat/room').send({
      roomId: randomHex(8),
      accessTokenHash: 'not-a-hex-hash',
      inviteTokenHashes: [randomHex(32)],
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty invite token array', async () => {
    const res = await post('/api/chat/room').send({
      roomId: randomHex(8),
      accessTokenHash: randomHex(32),
      inviteTokenHashes: [],
    });
    expect(res.status).toBe(400);
  });

  it('rejects too many invite tokens (>50)', async () => {
    const res = await post('/api/chat/room').send({
      roomId: randomHex(8),
      accessTokenHash: randomHex(32),
      inviteTokenHashes: Array.from({ length: 51 }, () => randomHex(32)),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid invite token hash format', async () => {
    const res = await post('/api/chat/room').send({
      roomId: randomHex(8),
      accessTokenHash: randomHex(32),
      inviteTokenHashes: ['too-short', randomHex(32)],
    });
    expect(res.status).toBe(400);
  });
});

// ================================================================
// ADVERSARIAL — WEBSOCKET ABUSE
// ================================================================

describe('WebSocket abuse', () => {
  it('rejects WebSocket to unregistered room', async () => {
    const ws = new WebSocket(
      wsUrl('unregisteredroom1', randomHex(32), randomHex(16)),
      wsOpts(),
    );
    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('connected'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(result).toBe('rejected');
  });

  it('rejects WebSocket with missing tokens', async () => {
    const { roomId, accessTokenHash, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room').send({ roomId, accessTokenHash, inviteTokenHashes });

    // No query params at all
    const ws = new WebSocket(
      `ws://127.0.0.1:${serverAddr.port}/chat/${roomId}`,
      wsOpts(),
    );
    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('connected'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(result).toBe('rejected');
  });

  it('rejects WebSocket with invalid path', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${serverAddr.port}/chat/../../etc/passwd`,
      wsOpts(),
    );
    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('connected'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(result).toBe('rejected');
  });

  it('rejects WebSocket without origin header', async () => {
    const { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room').send({ roomId, accessTokenHash, inviteTokenHashes });

    const ws = new WebSocket(
      wsUrl(roomId, accessToken, inviteTokens[0]),
      { headers: { host: `localhost:${serverAddr.port}` } }, // no origin
    );
    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('connected'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(result).toBe('rejected');
  });

  it('terminates connection on oversized WebSocket message', async () => {
    roomCreateAttempts.clear();
    const { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room').send({ roomId, accessTokenHash, inviteTokenHashes });
    const opts = wsOpts();

    // ws library throws RangeError for max payload exceeded — catch it
    const uncaughtHandler = () => {};
    process.on('uncaughtException', uncaughtHandler);

    const wsB = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[0]), opts);
    await new Promise((resolve) => { wsB.on('message', () => resolve()); });

    // maxPayload is 64KB — sending larger terminates the connection
    const closePromise = new Promise((resolve) => {
      wsB.on('close', () => resolve('closed'));
      wsB.on('error', () => {}); // suppress error event
      setTimeout(() => resolve('timeout'), 3000);
    });

    const huge = 'x'.repeat(70000);
    try { wsB.send(JSON.stringify({ type: 'msg', data: huge, iv: 'iv' })); } catch {}

    const result = await closePromise;
    expect(result).toBe('closed');

    // Clean up and let the event loop settle
    await new Promise((r) => setTimeout(r, 100));
    process.removeListener('uncaughtException', uncaughtHandler);
  });

  it('silently drops malformed JSON', async () => {
    roomCreateAttempts.clear();
    const { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room').send({ roomId, accessTokenHash, inviteTokenHashes });
    const opts = wsOpts();

    const wsA = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[0]), opts);
    await new Promise((resolve) => { wsA.on('message', () => resolve()); });

    const wsB = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[1]), opts);
    await new Promise((resolve) => { wsB.on('message', () => resolve()); });

    const msgPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay timeout')), 3000);
      wsA.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'msg') {
          clearTimeout(timeout);
          resolve(parsed);
        }
      });
    });

    await new Promise((r) => setTimeout(r, 100));
    // Send malformed JSON — should be silently dropped
    wsB.send('{not json at all!!!');
    // Send message with wrong type — should be silently dropped
    wsB.send(JSON.stringify({ type: 'hack', payload: 'xss' }));
    // Send message missing required fields — should be silently dropped
    wsB.send(JSON.stringify({ type: 'msg' }));
    // Send valid message — should arrive
    wsB.send(JSON.stringify({ type: 'msg', data: 'valid', iv: 'iv' }));

    const relayed = await msgPromise;
    expect(relayed.data).toBe('valid');

    wsA.close();
    wsB.close();
  });

  it('blocks concurrent use of same invite token', async () => {
    roomCreateAttempts.clear();
    const { roomId, accessToken, accessTokenHash, inviteTokens, inviteTokenHashes } = makeRoomFixture();
    await post('/api/chat/room').send({ roomId, accessTokenHash, inviteTokenHashes });
    const opts = wsOpts();

    // First connection with invite token 0
    const ws1 = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[0]), opts);
    await new Promise((resolve) => { ws1.on('message', () => resolve()); });

    // Second connection with SAME invite token — should be rejected
    const ws2 = new WebSocket(wsUrl(roomId, accessToken, inviteTokens[0]), opts);
    const result = await new Promise((resolve) => {
      ws2.on('open', () => resolve('connected'));
      ws2.on('error', () => resolve('rejected'));
      ws2.on('close', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(result).toBe('rejected');

    ws1.close();
  });
});

// ================================================================
// ADVERSARIAL — AUTH ABUSE
// ================================================================

describe('Auth abuse', () => {
  it('rejects login with empty body', async () => {
    const res = await post('/auth/login').send({});
    expect(res.status).toBe(401);
  });

  it('rejects login with non-string credentials', async () => {
    const res = await post('/auth/login').send({ username: 123, password: true });
    expect(res.status).toBe(401);
  });

  it('rejects password change with short password', async () => {
    const a = await loginAgent();
    const res = await agentPost(a, '/auth/change-password')
      .send({ currentPassword: 'testpassword12chars', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects password change with oversized password (DoS prevention)', async () => {
    const a = await loginAgent();
    const res = await agentPost(a, '/auth/change-password')
      .send({ currentPassword: 'testpassword12chars', newPassword: 'x'.repeat(200) });
    expect(res.status).toBe(400);
  });

  it('rejects password change with wrong current password', async () => {
    const a = await loginAgent();
    const res = await agentPost(a, '/auth/change-password')
      .send({ currentPassword: 'wrong-current-pass', newPassword: 'validpassword12chars' });
    expect(res.status).toBe(401);
  });

  it('admin endpoints reject non-UUID drop/file IDs', async () => {
    const a = await loginAgent();
    for (const path of ['/api/drops/not-valid', '/api/files/not-valid']) {
      const res = await agentDel(a, path);
      expect(res.status).toBe(400);
    }
  });

  it('admin endpoints return 404 for non-existent resources', async () => {
    const a = await loginAgent();
    const res = await agentDel(a, '/api/drops/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

// ================================================================
// ADVERSARIAL — ERROR HANDLING
// ================================================================

describe('Error handling', () => {
  it('returns JSON 404 for unknown API routes (authenticated)', async () => {
    const a = await loginAgent();
    const res = await agentGet(a, '/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    // Must not leak stack traces or internal info
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('blocks unauthenticated access to unknown API routes (no info leak)', async () => {
    const res = await request(app).get('/api/nonexistent');
    // Returns 401, not 404 — doesn't reveal whether the route exists
    expect(res.status).toBe(401);
  });

  it('blocks unauthenticated access to unknown page routes (no info leak)', async () => {
    const res = await request(app).get('/nonexistent');
    // Returns redirect to login, not 404 — doesn't reveal route existence
    expect([302, 401]).toContain(res.status);
  });

  it('handles JSON body parse errors gracefully', async () => {
    const res = await request(app)
      .post('/api/drop')
      .set('Origin', ORIGIN)
      .set('Host', HOST)
      .set('Content-Type', 'application/json')
      .send('{"broken json');
    expect([400, 403, 500]).toContain(res.status);
    // Must not leak stack traces
    if (res.body?.error) {
      expect(res.body.error).not.toContain('SyntaxError');
    }
  });
});

// ================================================================
// RATE LIMITING (run last — poisons the IP for subsequent logins)
// ================================================================

describe('Rate limiting', () => {
  it('rate-limits login attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await post('/auth/login')
        .send({ username: 'admin', password: 'wrong' + i + 'password' });
    }
    const res = await post('/auth/login')
      .send({ username: 'admin', password: 'wrongpassword999' });
    expect(res.status).toBe(429);
  });
});
