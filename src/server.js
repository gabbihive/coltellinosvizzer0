require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const startedAt = new Date();

const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASS) {
  console.error('ADMIN_PASSWORD env var is required. Set it in .env');
  process.exit(1);
}

if (ADMIN_PASS.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET env var is required in production.');
    process.exit(1);
  }
  console.warn('WARNING: SESSION_SECRET not set. Sessions will not survive restarts.');
}

// --- Password hashing (scrypt, no external deps) ---

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

const initialPasswordHash = (() => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(ADMIN_PASS, salt, 64, SCRYPT_OPTS).toString('hex');
  return `${salt}:${hash}`;
})();
let adminPasswordHash = null; // in-memory override (resets on restart)

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_OPTS).toString('hex');
  return `${salt}:${hash}`;
}

function verifyHashedPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, storedHash] = parts;
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_OPTS).toString('hex');
  if (hash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

function verifyAdminPassword(password) {
  return verifyHashedPassword(password, adminPasswordHash || initialPasswordHash);
}

// --- Login rate limiting ---

const loginAttempts = new Map(); // ip -> { count, resetAt }

function checkLoginRate(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 60000; }
  if (attempt.count >= 5) return false;
  attempt.count++;
  loginAttempts.set(ip, attempt);
  return true;
}

// --- Retrieval rate limiting ---

const retrievalAttempts = new Map(); // ip -> { count, resetAt }
function checkRetrievalRate(ip) {
  const now = Date.now();
  const attempt = retrievalAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 60000; }
  if (attempt.count >= 60) return false;
  attempt.count++;
  retrievalAttempts.set(ip, attempt);
  return true;
}

// --- In-memory paste store ---

const pastes = new Map(); // id -> { encrypted, iv, burnAfterRead, expiresAt, createdAt }
const PASTE_MAX_SIZE = 256 * 1024; // 256 KB
const PASTE_MAX_COUNT = 10000;
const PASTE_EXPIRY_OPTIONS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Periodic cleanup of expired pastes
setInterval(() => {
  const now = Date.now();
  for (const [id, paste] of pastes) {
    if (paste.expiresAt <= now) pastes.delete(id);
  }
}, 60 * 1000);

// --- In-memory file store ---

const fileStore = new Map(); // id -> { encrypted, iv, encryptedMeta, metaIv, burnAfterRead, expiresAt, createdAt, size }
const FILE_MAX_SIZE = 14 * 1024 * 1024; // ~10 MB original file in base64 ciphertext
const FILE_MAX_COUNT = 1000;
const FILE_MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500 MB total
let filesTotalSize = 0;

const FILE_EXPIRY_OPTIONS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Periodic cleanup of expired files
setInterval(() => {
  const now = Date.now();
  for (const [id, file] of fileStore) {
    if (file.expiresAt <= now) {
      filesTotalSize -= file.size;
      fileStore.delete(id);
    }
  }
}, 60 * 1000);

// File upload rate limiting (20 per IP per hour)
const uploadAttempts = new Map(); // ip -> { count, resetAt }
function checkUploadRate(ip) {
  const now = Date.now();
  const attempt = uploadAttempts.get(ip) || { count: 0, resetAt: now + 3600000 };
  if (now > attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 3600000; }
  if (attempt.count >= 20) return false;
  attempt.count++;
  uploadAttempts.set(ip, attempt);
  return true;
}

// --- Registered chat rooms (access control + invite tokens) ---

const registeredRooms = new Map(); // roomId -> { accessTokenHash, invites, createdAt, expiresAt }
const ROOM_MAX_LIFETIME = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ROOMS = 1000;

const roomCreateAttempts = new Map();
function checkRoomCreateRate(ip) {
  const now = Date.now();
  const attempt = roomCreateAttempts.get(ip) || { count: 0, resetAt: now + 3600000 };
  if (now > attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 3600000; }
  if (attempt.count >= 10) return false;
  attempt.count++;
  roomCreateAttempts.set(ip, attempt);
  return true;
}

// --- Request log (in-memory ring buffer) ---

const requestLog = [];
const MAX_LOG_ENTRIES = 200;

// --- HTML templates with CSP nonce injection ---

const htmlTemplates = {};
for (const name of ['drop', 'chat', 'file', 'landing', 'login', 'index']) {
  const filePath = path.join(__dirname, 'public', `${name}.html`);
  htmlTemplates[name] = fs.readFileSync(filePath, 'utf-8');
}

const TOOL_ROUTES = new Set(['/drop', '/chat', '/file']);
const TOOL_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

function serveWithCSP(templateName, req, res, options = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = htmlTemplates[templateName].replace(/<script>/g, `<script nonce="${nonce}">`);
  const host = req.get('host') || 'localhost';

  const cspDirectives = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src blob: data:",
    `connect-src 'self'${options.wss ? ` wss://${host}` : ''}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ];

  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));

  // Anti-caching for tool pages
  if (options.noCache) {
    for (const [k, v] of Object.entries(TOOL_CACHE_HEADERS)) res.setHeader(k, v);
  }

  // Cross-origin isolation for tool pages
  if (options.isolate) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }

  res.type('html').send(html);
}

// --- Middleware ---

app.set('trust proxy', 1);
const jsonSmall = express.json({ limit: '512kb' });
const jsonLarge = express.json({ limit: '15mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/file') return jsonLarge(req, res, next);
  jsonSmall(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), accelerometer=(), gyroscope=(), magnetometer=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), midi=(), screen-wake-lock=(), idle-detection=(), display-capture=(), document-domain=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CSRF origin check on state-changing requests
const CSRF_EXEMPT_PATHS = new Set(['/api/drop', '/api/file', '/api/chat/room']);
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.get('origin');
    const referer = req.get('referer');
    const host = req.get('host');
    let sourceHost = null;
    try {
      if (origin) sourceHost = new URL(origin).host;
      else if (referer) sourceHost = new URL(referer).host;
    } catch {}
    // Block cross-origin requests
    if (sourceHost && sourceHost !== host) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Deny missing origin on authenticated endpoints (CSRF defense-in-depth)
    if (!sourceHost && !CSRF_EXEMPT_PATHS.has(req.path)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.match(/\.(html|css|js|ico|png|svg|woff2?)$/) || req.path === '/auth/check' || req.path.startsWith('/drop') || req.path.startsWith('/api/drop') || req.path.startsWith('/chat') || req.path.startsWith('/api/chat') || req.path.startsWith('/file') || req.path.startsWith('/api/file')) return;
    requestLog.unshift({
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    });
    if (requestLog.length > MAX_LOG_ENTRIES) requestLog.length = MAX_LOG_ENTRIES;
  });
  next();
});

// --- Auth routes (public) ---

// Dummy hash for timing-safe username validation
const DUMMY_HASH = hashPassword('dummy-timing-equalization');

app.post('/auth/login', (req, res) => {
  if (!checkLoginRate(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const { username, password } = req.body;
  if (username !== ADMIN_USER) {
    // Run dummy scrypt to equalize timing with valid-username path
    verifyHashedPassword(password || '', DUMMY_HASH);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (verifyAdminPassword(password)) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/auth/check', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

app.post('/auth/change-password', (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (newPassword.length > 128) {
    return res.status(400).json({ error: 'Password too long' });
  }
  if (!verifyAdminPassword(currentPassword)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  adminPasswordHash = hashPassword(newPassword);
  res.json({ ok: true });
});

// --- Auth middleware ---

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login.html');
}

app.get('/panel', (req, res, next) => requireAuth(req, res, () => {
  serveWithCSP('index', req, res, { noCache: true, isolate: true });
}));

// Public routes (no auth required)
app.get('/', (req, res) => serveWithCSP('landing', req, res));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/login.html', (req, res) => serveWithCSP('login', req, res));
app.get('/landing.html', (req, res) => serveWithCSP('landing', req, res));

// --- Signal Room (encrypted chat) ---

app.get('/chat', (req, res) => serveWithCSP('chat', req, res, { noCache: true, isolate: true, wss: true }));
app.get('/chat/:id', (req, res) => serveWithCSP('chat', req, res, { noCache: true, isolate: true, wss: true }));

// Room creation API (public — no auth required)
app.post('/api/chat/room', (req, res) => {
  if (!checkRoomCreateRate(req.ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  const { roomId, accessTokenHash, inviteTokenHashes } = req.body;
  if (!roomId || !accessTokenHash || !inviteTokenHashes) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (typeof roomId !== 'string' || !/^[a-zA-Z0-9]{16}$/.test(roomId)) {
    return res.status(400).json({ error: 'Invalid room ID' });
  }
  if (typeof accessTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(accessTokenHash)) {
    return res.status(400).json({ error: 'Invalid access token' });
  }
  if (!Array.isArray(inviteTokenHashes) || inviteTokenHashes.length < 2 || inviteTokenHashes.length > 50) {
    return res.status(400).json({ error: 'Invite tokens required (2-50)' });
  }
  for (const h of inviteTokenHashes) {
    if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) {
      return res.status(400).json({ error: 'Invalid invite token hash' });
    }
  }
  if (registeredRooms.has(roomId)) {
    return res.status(409).json({ error: 'Room exists' });
  }
  if (registeredRooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: 'Server at capacity' });
  }
  const now = Date.now();
  const invites = new Map();
  for (const h of inviteTokenHashes) {
    invites.set(h, { active: false, peerId: null });
  }
  registeredRooms.set(roomId, {
    accessTokenHash,
    invites,
    createdAt: now,
    expiresAt: now + ROOM_MAX_LIFETIME,
  });
  res.status(201).json({ ok: true, expiresAt: now + ROOM_MAX_LIFETIME });
});

// --- Dead Drop (anonymous paste bin) ---

app.get('/drop', (req, res) => serveWithCSP('drop', req, res, { noCache: true, isolate: true }));
app.get('/drop/:id', (req, res) => serveWithCSP('drop', req, res, { noCache: true, isolate: true }));

app.post('/api/drop', (req, res) => {
  const { encrypted, iv, burn, expiry } = req.body;
  if (!encrypted || !iv || typeof encrypted !== 'string' || typeof iv !== 'string') {
    return res.status(400).json({ error: 'Missing encrypted data' });
  }
  if (iv.length > 24) {
    return res.status(400).json({ error: 'Invalid IV' });
  }
  if (encrypted.length > PASTE_MAX_SIZE) {
    return res.status(413).json({ error: 'Paste too large (256 KB max)' });
  }
  if (pastes.size >= PASTE_MAX_COUNT) {
    return res.status(503).json({ error: 'Server at capacity. Try again later.' });
  }
  const ttl = PASTE_EXPIRY_OPTIONS[expiry] || PASTE_EXPIRY_OPTIONS['24h'];
  const id = crypto.randomUUID();
  const now = Date.now();
  pastes.set(id, {
    encrypted,
    iv,
    burnAfterRead: !!burn,
    expiresAt: now + ttl,
    createdAt: now,
  });
  res.status(201).json({ id });
});

app.get('/api/drop/:id', (req, res) => {
  if (!checkRetrievalRate(req.ip)) return res.status(429).json({ error: 'Rate limit exceeded' });
  if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const paste = pastes.get(req.params.id);
  if (!paste || paste.expiresAt <= Date.now()) {
    if (paste) pastes.delete(req.params.id);
    return res.status(404).json({ error: 'Paste not found or expired' });
  }
  if (paste.burnAfterRead) {
    pastes.delete(req.params.id);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ encrypted: paste.encrypted, iv: paste.iv, burn: paste.burnAfterRead });
});

// --- File Drop (encrypted file sharing) ---

app.get('/file', (req, res) => serveWithCSP('file', req, res, { noCache: true, isolate: true }));
app.get('/file/:id', (req, res) => serveWithCSP('file', req, res, { noCache: true, isolate: true }));

app.post('/api/file', (req, res) => {
  if (!checkUploadRate(req.ip)) {
    return res.status(429).json({ error: 'Upload limit exceeded. Try again later.' });
  }
  const { encrypted, iv, encryptedMeta, metaIv, burn, expiry } = req.body;
  if (!encrypted || !iv || !encryptedMeta || !metaIv) {
    return res.status(400).json({ error: 'Missing encrypted data' });
  }
  if (typeof encrypted !== 'string' || typeof iv !== 'string' || typeof encryptedMeta !== 'string' || typeof metaIv !== 'string') {
    return res.status(400).json({ error: 'Invalid field types' });
  }
  if (iv.length > 24 || metaIv.length > 24) {
    return res.status(400).json({ error: 'Invalid IV' });
  }
  if (encrypted.length > FILE_MAX_SIZE) {
    return res.status(413).json({ error: 'File too large (10 MB max)' });
  }
  if (encryptedMeta.length > 4096) {
    return res.status(400).json({ error: 'Metadata too large' });
  }
  if (fileStore.size >= FILE_MAX_COUNT) {
    return res.status(503).json({ error: 'Server at capacity. Try again later.' });
  }
  const size = encrypted.length + encryptedMeta.length;
  if (filesTotalSize + size > FILE_MAX_TOTAL_SIZE) {
    return res.status(503).json({ error: 'Storage full. Try again later.' });
  }
  const ttl = FILE_EXPIRY_OPTIONS[expiry] || FILE_EXPIRY_OPTIONS['24h'];
  const id = crypto.randomUUID();
  const now = Date.now();
  fileStore.set(id, {
    encrypted, iv, encryptedMeta, metaIv,
    burnAfterRead: !!burn,
    expiresAt: now + ttl,
    createdAt: now,
    size,
  });
  filesTotalSize += size;
  res.status(201).json({ id });
});

app.get('/api/file/:id', (req, res) => {
  if (!checkRetrievalRate(req.ip)) return res.status(429).json({ error: 'Rate limit exceeded' });
  if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const file = fileStore.get(req.params.id);
  if (!file || file.expiresAt <= Date.now()) {
    if (file) {
      filesTotalSize -= file.size;
      fileStore.delete(req.params.id);
    }
    return res.status(404).json({ error: 'File not found or expired' });
  }
  if (file.burnAfterRead) {
    filesTotalSize -= file.size;
    fileStore.delete(req.params.id);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    encrypted: file.encrypted,
    iv: file.iv,
    encryptedMeta: file.encryptedMeta,
    metaIv: file.metaIv,
    burn: file.burnAfterRead,
  });
});

// Everything else requires auth
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// --- API: Status ---

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    startedAt: startedAt.toISOString(),
    nodeVersion: process.version,
    memoryUsage: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// --- API: System ---

app.get('/api/system', (req, res) => {
  const ALLOWED_ENV = ['NODE_ENV', 'PORT', 'ADMIN_USERNAME'];
  const env = {};
  for (const key of ALLOWED_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Show existence of secrets without values
  for (const key of ['SESSION_SECRET', 'ADMIN_PASSWORD']) {
    env[key] = process.env[key] ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : '(not set)';
  }
  res.json({
    nodeVersion: process.version,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemory: Math.round(os.totalmem() / 1024 / 1024),
    freeMemory: Math.round(os.freemem() / 1024 / 1024),
    processMemory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptime: Math.floor(process.uptime()),
    env,
  });
});

// --- API: Logs ---

app.get('/api/logs', (req, res) => {
  res.json(requestLog);
});

// --- API: Drops (admin) ---

app.get('/api/drops', (req, res) => {
  const now = Date.now();
  const drops = [];
  for (const [id, p] of pastes) {
    drops.push({
      id,
      burnAfterRead: p.burnAfterRead,
      expiresAt: new Date(p.expiresAt).toISOString(),
      createdAt: new Date(p.createdAt).toISOString(),
      expired: p.expiresAt <= now,
    });
  }
  drops.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(drops.slice(0, 100));
});

app.get('/api/drops/stats', (req, res) => {
  const now = Date.now();
  let total = 0, active = 0, burn = 0;
  for (const p of pastes.values()) {
    total++;
    if (p.expiresAt > now) {
      active++;
      if (p.burnAfterRead) burn++;
    }
  }
  res.json({ total, active, expired: total - active, burn });
});

app.delete('/api/drops/:id', (req, res) => {
  if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  if (!pastes.has(req.params.id)) {
    return res.status(404).json({ error: 'Drop not found' });
  }
  pastes.delete(req.params.id);
  res.status(204).end();
});

app.post('/api/drops/purge-expired', (req, res) => {
  const now = Date.now();
  let purged = 0;
  for (const [id, p] of pastes) {
    if (p.expiresAt <= now) { pastes.delete(id); purged++; }
  }
  res.json({ purged });
});

// --- API: Files (admin) ---

app.get('/api/files', (req, res) => {
  const now = Date.now();
  const items = [];
  for (const [id, f] of fileStore) {
    items.push({
      id,
      burnAfterRead: f.burnAfterRead,
      expiresAt: new Date(f.expiresAt).toISOString(),
      createdAt: new Date(f.createdAt).toISOString(),
      expired: f.expiresAt <= now,
      size: f.size,
    });
  }
  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(items.slice(0, 100));
});

app.get('/api/files/stats', (req, res) => {
  const now = Date.now();
  let total = 0, active = 0, burn = 0;
  for (const f of fileStore.values()) {
    total++;
    if (f.expiresAt > now) {
      active++;
      if (f.burnAfterRead) burn++;
    }
  }
  res.json({ total, active, expired: total - active, burn, totalSize: filesTotalSize });
});

app.delete('/api/files/:id', (req, res) => {
  if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const file = fileStore.get(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  filesTotalSize -= file.size;
  fileStore.delete(req.params.id);
  res.status(204).end();
});

app.post('/api/files/purge-expired', (req, res) => {
  const now = Date.now();
  let purged = 0;
  for (const [id, f] of fileStore) {
    if (f.expiresAt <= now) {
      filesTotalSize -= f.size;
      fileStore.delete(id);
      purged++;
    }
  }
  res.json({ purged });
});

// --- API: Chat stats (admin) ---

const chatRooms = new Map(); // roomId -> Set<ws>

app.get('/api/chat/stats', (req, res) => {
  let totalClients = 0;
  for (const clients of chatRooms.values()) totalClients += clients.size;
  res.json({ rooms: chatRooms.size, clients: totalClients, registered: registeredRooms.size });
});

// --- API: Rooms (admin) ---

app.get('/api/chat/rooms', (req, res) => {
  const now = Date.now();
  const rooms = [];
  for (const [id, config] of registeredRooms) {
    const clients = chatRooms.get(id);
    rooms.push({
      id,
      createdAt: new Date(config.createdAt).toISOString(),
      expiresAt: new Date(config.expiresAt).toISOString(),
      expired: config.expiresAt <= now,
      invitesRemaining: config.invites.size,
      connected: clients ? clients.size : 0,
    });
  }
  rooms.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(rooms);
});

app.delete('/api/chat/rooms/:id', (req, res) => {
  const roomId = req.params.id;
  if (!/^[a-zA-Z0-9]{16}$/.test(roomId)) return res.status(400).json({ error: 'Invalid room ID' });
  const config = registeredRooms.get(roomId);
  if (!config) return res.status(404).json({ error: 'Room not found' });
  const room = chatRooms.get(roomId);
  if (room) {
    const msg = JSON.stringify({ type: 'expired' });
    for (const ws of room) {
      try { ws.send(msg); } catch {}
      try { ws.close(1000, 'Room terminated'); } catch {}
    }
    chatRooms.delete(roomId);
  }
  registeredRooms.delete(roomId);
  res.status(204).end();
});

app.post('/api/chat/rooms/purge', (req, res) => {
  let count = 0;
  for (const [roomId] of registeredRooms) {
    const room = chatRooms.get(roomId);
    if (room) {
      const msg = JSON.stringify({ type: 'expired' });
      for (const ws of room) {
        try { ws.send(msg); } catch {}
        try { ws.close(1000, 'Rooms purged'); } catch {}
      }
      chatRooms.delete(roomId);
    }
    count++;
  }
  registeredRooms.clear();
  res.json({ purged: count });
});

// --- 404 and error handlers ---

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).type('html').send('<html><body style="background:#0a0a0a;color:#444;font-family:monospace;padding:60px;text-align:center"><h1>404</h1></body></html>');
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: 'Internal error' });
});

// --- Start ---

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// --- WebSocket relay for Signal Room ---

const { WebSocketServer } = require('ws');

const MAX_MSG_SIZE = 65536; // 64 KB
const MAX_ROOM_SIZE = 50;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_TOTAL_CONNECTIONS = 500;
const RATE_LIMIT = 10; // messages per second
const ipConnections = new Map(); // ip -> count

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_SIZE });

// Determine allowed WebSocket origins
const ALLOWED_WS_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  'https://server-express-u3tu.onrender.com',
]);
if (process.env.RENDER_EXTERNAL_URL) {
  ALLOWED_WS_ORIGINS.add(process.env.RENDER_EXTERNAL_URL);
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/chat\/([a-zA-Z0-9]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const roomId = match[1];

  // Origin validation (required — reject missing origin)
  const origin = request.headers.origin;
  if (!origin || !ALLOWED_WS_ORIGINS.has(origin)) {
    socket.destroy();
    return;
  }

  // Global connection limit
  if (wss.clients.size >= MAX_TOTAL_CONNECTIONS) {
    socket.destroy();
    return;
  }

  // Per-IP connection limit
  const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress;
  const ipCount = ipConnections.get(ip) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    socket.destroy();
    return;
  }

  // Room must be registered
  const roomConfig = registeredRooms.get(roomId);
  if (!roomConfig) {
    socket.destroy();
    return;
  }

  // Check room expiry
  if (Date.now() > roomConfig.expiresAt) {
    registeredRooms.delete(roomId);
    socket.destroy();
    return;
  }

  // Verify access token (HKDF-derived, proves key possession)
  const accessToken = url.searchParams.get('access');
  if (!accessToken || typeof accessToken !== 'string' || !/^[a-f0-9]{64}$/.test(accessToken)) {
    socket.destroy();
    return;
  }
  const accessHash = crypto.createHash('sha256').update(Buffer.from(accessToken, 'hex')).digest('hex');
  if (accessHash.length !== roomConfig.accessTokenHash.length ||
      !crypto.timingSafeEqual(Buffer.from(accessHash), Buffer.from(roomConfig.accessTokenHash))) {
    socket.destroy();
    return;
  }

  // Verify and claim invite token (one concurrent connection per token)
  const inviteToken = url.searchParams.get('invite');
  if (!inviteToken || typeof inviteToken !== 'string' || !/^[a-f0-9]{32}$/.test(inviteToken)) {
    socket.destroy();
    return;
  }
  const inviteHash = crypto.createHash('sha256').update(Buffer.from(inviteToken, 'hex')).digest('hex');
  const invite = roomConfig.invites.get(inviteHash);
  if (!invite) {
    socket.destroy();
    return;
  }
  if (invite.active) {
    socket.destroy(); // Token already in use by another connection
    return;
  }

  // Reject if room is full
  const room = chatRooms.get(roomId);
  if (room && room.size >= MAX_ROOM_SIZE) {
    socket.destroy();
    return;
  }

  // Claim invite token and track IP
  invite.active = true;
  ipConnections.set(ip, ipCount + 1);

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, roomId, ip, inviteHash, roomConfig.expiresAt);
  });
});

wss.on('connection', (ws, roomId, ip, inviteHash, expiresAt) => {
  // Assign anonymous peer ID
  const peerId = crypto.randomBytes(2).toString('hex');

  // Add to room
  if (!chatRooms.has(roomId)) chatRooms.set(roomId, new Set());
  const room = chatRooms.get(roomId);
  room.add(ws);

  // Rate limiting state
  let msgCount = 0;
  const rateLimitInterval = setInterval(() => { msgCount = 0; }, 1000);

  // Send init to joining peer (include room expiry for client countdown)
  ws.send(JSON.stringify({ type: 'init', peer: peerId, count: room.size, expiresAt }));

  // Broadcast join to others
  for (const peer of room) {
    if (peer !== ws && peer.readyState === 1) {
      peer.send(JSON.stringify({ type: 'join', peer: peerId, count: room.size }));
    }
  }

  ws.on('message', (data) => {
    // Rate limit
    msgCount++;
    if (msgCount > RATE_LIMIT) return;

    // Size limit
    const raw = typeof data === 'string' ? data : data.toString();
    if (raw.length > MAX_MSG_SIZE) return;

    // Validate it looks like JSON with type "msg" (but don't parse content)
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.type !== 'msg' || !parsed.data || !parsed.iv) return;

    // Attach peer ID and broadcast to ALL in room (including sender for confirmation)
    const relay = JSON.stringify({ type: 'msg', data: parsed.data, iv: parsed.iv, from: peerId });
    for (const peer of room) {
      if (peer.readyState === 1) {
        peer.send(relay);
      }
    }
  });

  ws.on('close', () => {
    clearInterval(rateLimitInterval);
    room.delete(ws);

    // Release IP slot
    const count = ipConnections.get(ip) || 1;
    if (count <= 1) ipConnections.delete(ip);
    else ipConnections.set(ip, count - 1);

    // Release invite token so the same user can reconnect
    const roomConfig = registeredRooms.get(roomId);
    if (roomConfig) {
      const invite = roomConfig.invites.get(inviteHash);
      if (invite) invite.active = false;
    }

    if (room.size === 0) {
      chatRooms.delete(roomId);
    } else {
      // Broadcast leave
      for (const peer of room) {
        if (peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'leave', peer: peerId, count: room.size }));
        }
      }
    }
  });

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat interval to clean stale connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Periodic cleanup of stale IP connection entries
setInterval(() => {
  for (const [ip, count] of ipConnections) {
    if (count <= 0) ipConnections.delete(ip);
  }
}, 60000);

// Periodic cleanup of expired rooms
setInterval(() => {
  const now = Date.now();
  for (const [roomId, config] of registeredRooms) {
    if (now > config.expiresAt) {
      registeredRooms.delete(roomId);
      const room = chatRooms.get(roomId);
      if (room) {
        const expMsg = JSON.stringify({ type: 'expired' });
        for (const ws of room) {
          try { ws.send(expMsg); } catch {}
          try { ws.close(1000, 'Room expired'); } catch {}
        }
        chatRooms.delete(roomId);
      }
    }
  }
}, 30000);
