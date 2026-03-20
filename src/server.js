require('dotenv').config();
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const prisma = require('./lib/prisma');

const app = express();
const PORT = process.env.PORT || 3000;
const startedAt = new Date();

const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASS) {
  console.error('ADMIN_PASSWORD env var is required. Set it in .env');
  process.exit(1);
}

// --- Password hashing (scrypt, no external deps) ---

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyHashedPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, storedHash] = parts;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  if (hash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

async function verifyAdminPassword(password) {
  // Check for DB-stored password override first
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: 'admin_password_hash' },
    });
    if (setting) {
      return verifyHashedPassword(password, setting.value);
    }
  } catch {
    // Setting table may not exist yet (pre-migration)
  }
  // Fall back to env var
  const passBuffer = Buffer.from(password || '');
  const adminBuffer = Buffer.from(ADMIN_PASS);
  return passBuffer.length === adminBuffer.length &&
    crypto.timingSafeEqual(passBuffer, adminBuffer);
}

// --- Request log (in-memory ring buffer) ---

const requestLog = [];
const MAX_LOG_ENTRIES = 200;

// --- BigInt serialization helper ---

function serialize(data) {
  return JSON.parse(JSON.stringify(data, (_, v) =>
    typeof v === 'bigint' ? Number(v) : v
  ));
}

// --- Middleware ---

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    if (req.path.match(/\.(html|css|js|ico|png|svg|woff2?)$/) || req.path === '/auth/check' || req.path.startsWith('/drop') || req.path.startsWith('/api/drop') || req.path.startsWith('/chat') || req.path.startsWith('/api/chat')) return;
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

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const valid = await verifyAdminPassword(password);
  if (valid) {
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

app.post('/auth/change-password', async (req, res) => {
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
  const valid = await verifyAdminPassword(currentPassword);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  try {
    await prisma.setting.upsert({
      where: { key: 'admin_password_hash' },
      update: { value: hashPassword(newPassword) },
      create: { key: 'admin_password_hash', value: hashPassword(newPassword) },
    });
  } catch {
    return res.status(500).json({ error: 'Failed to save. Run: npx prisma migrate dev' });
  }
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
}));

// Public routes (no auth required)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
app.use('/landing.html', express.static(path.join(__dirname, 'public', 'landing.html')));

// --- Signal Room (encrypted chat) ---

app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/chat/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// --- Dead Drop (anonymous paste bin) ---

const PASTE_MAX_SIZE = 256 * 1024; // 256 KB
const PASTE_EXPIRY_OPTIONS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

app.get('/drop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'drop.html')));
app.get('/drop/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'drop.html')));

app.post('/api/drop', async (req, res) => {
  const { encrypted, iv, burn, expiry } = req.body;
  if (!encrypted || !iv) {
    return res.status(400).json({ error: 'Missing encrypted data' });
  }
  if (encrypted.length > PASTE_MAX_SIZE) {
    return res.status(413).json({ error: 'Paste too large (256 KB max)' });
  }
  const ttl = PASTE_EXPIRY_OPTIONS[expiry] || PASTE_EXPIRY_OPTIONS['24h'];
  const paste = await prisma.paste.create({
    data: {
      encrypted,
      iv,
      burnAfterRead: !!burn,
      expiresAt: new Date(Date.now() + ttl),
    },
  });
  res.status(201).json({ id: paste.id });
});

app.get('/api/drop/:id', async (req, res) => {
  const paste = await prisma.paste.findUnique({
    where: { id: req.params.id },
  });
  if (!paste || paste.expiresAt < new Date()) {
    if (paste) await prisma.paste.delete({ where: { id: paste.id } }).catch(() => {});
    return res.status(404).json({ error: 'Paste not found or expired' });
  }
  if (paste.burnAfterRead) {
    await prisma.paste.delete({ where: { id: paste.id } }).catch(() => {});
  }
  res.json({ encrypted: paste.encrypted, iv: paste.iv, burn: paste.burnAfterRead });
});

// Everything else requires auth
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// --- API: Status ---

app.get('/api/status', async (req, res) => {
  const userCount = await prisma.user.count();
  res.json({
    status: 'running',
    uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    startedAt: startedAt.toISOString(),
    nodeVersion: process.version,
    memoryUsage: Math.round(process.memoryUsage().rss / 1024 / 1024),
    userCount,
  });
});

// --- API: Users ---

app.get('/api/users', async (req, res) => {
  const users = await prisma.user.findMany();
  res.json(users);
});

app.get('/api/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: Number(req.params.id) },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/users', async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const user = await prisma.user.create({ data: { email, name } });
    res.status(201).json(user);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    throw err;
  }
});

app.put('/api/users/:id', async (req, res) => {
  const { email, name } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: Number(req.params.id) },
      data: { email, name },
    });
    res.json(user);
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'User not found' });
    }
    throw err;
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    await prisma.user.delete({
      where: { id: Number(req.params.id) },
    });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'User not found' });
    }
    throw err;
  }
});

// --- API: Database ---

app.get('/api/db/info', async (req, res) => {
  try {
    const [info] = await prisma.$queryRaw`
      SELECT current_database() as database,
             current_user as "user",
             version() as version`;
    const [size] = await prisma.$queryRaw`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size`;
    res.json({ ...info, size: size.size });
  } catch {
    res.status(500).json({ error: 'Database connection failed' });
  }
});

app.get('/api/db/tables', async (req, res) => {
  const tables = await prisma.$queryRaw`
    SELECT t.tablename as name,
           s.n_live_tup as row_count
    FROM pg_tables t
    LEFT JOIN pg_stat_user_tables s ON s.relname = t.tablename
    WHERE t.schemaname = 'public'
    ORDER BY t.tablename`;
  res.json(serialize(tables));
});

app.get('/api/db/tables/:name', async (req, res) => {
  const { name } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const offset = (page - 1) * limit;

  // Validate table name against actual DB tables
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  if (!tables.some(t => t.tablename === name)) {
    return res.status(404).json({ error: 'Table not found' });
  }

  const columns = await prisma.$queryRaw`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${name}
    ORDER BY ordinal_position`;

  const [countResult] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::integer as total FROM "${name}"`
  );

  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "${name}" ORDER BY 1 DESC LIMIT $1 OFFSET $2`,
    limit, offset
  );

  res.json(serialize({
    name,
    columns,
    total: countResult.total,
    page,
    limit,
    pages: Math.ceil(countResult.total / limit),
    rows,
  }));
});

app.get('/api/db/migrations', async (req, res) => {
  try {
    const migrations = await prisma.$queryRaw`
      SELECT migration_name, started_at, finished_at, applied_steps_count
      FROM "_prisma_migrations"
      ORDER BY started_at DESC`;
    res.json(serialize(migrations));
  } catch {
    res.json([]);
  }
});

// --- API: System ---

app.get('/api/system', (req, res) => {
  const sensitiveKeys = ['PASSWORD', 'SECRET', 'TOKEN', 'KEY', 'DATABASE_URL'];
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('npm_') || key.startsWith('__') || key === 'PATH' || key === 'HOME') continue;
    const sensitive = sensitiveKeys.some(s => key.toUpperCase().includes(s));
    env[key] = sensitive ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : value;
  }
  res.json({
    pid: process.pid,
    nodeVersion: process.version,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemory: Math.round(os.totalmem() / 1024 / 1024),
    freeMemory: Math.round(os.freemem() / 1024 / 1024),
    processMemory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptime: Math.floor(process.uptime()),
    cwd: process.cwd(),
    env,
  });
});

// --- API: Logs ---

app.get('/api/logs', (req, res) => {
  res.json(requestLog);
});

// --- API: Drops (admin) ---

app.get('/api/drops', async (req, res) => {
  const drops = await prisma.paste.findMany({
    select: { id: true, burnAfterRead: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const now = new Date();
  res.json(drops.map(d => ({
    ...d,
    expired: d.expiresAt < now,
    size: undefined,
  })));
});

app.get('/api/drops/stats', async (req, res) => {
  const total = await prisma.paste.count();
  const active = await prisma.paste.count({ where: { expiresAt: { gt: new Date() } } });
  const burnCount = await prisma.paste.count({ where: { burnAfterRead: true, expiresAt: { gt: new Date() } } });
  res.json({ total, active, expired: total - active, burn: burnCount });
});

app.delete('/api/drops/:id', async (req, res) => {
  try {
    await prisma.paste.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Drop not found' });
    throw err;
  }
});

app.post('/api/drops/purge-expired', async (req, res) => {
  const { count } = await prisma.paste.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  res.json({ purged: count });
});

// --- API: Chat stats (admin) ---

const chatRooms = new Map(); // roomId -> Set<ws>

app.get('/api/chat/stats', (req, res) => {
  let totalClients = 0;
  for (const clients of chatRooms.values()) totalClients += clients.size;
  res.json({ rooms: chatRooms.size, clients: totalClients });
});

// --- Start ---

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// --- WebSocket relay for Signal Room ---

const { WebSocketServer } = require('ws');

const MAX_MSG_SIZE = 65536; // 64 KB
const MAX_ROOM_SIZE = 50;
const MAX_ROOMS = 1000;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_TOTAL_CONNECTIONS = 500;
const RATE_LIMIT = 10; // messages per second
const ipConnections = new Map(); // ip -> count

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_SIZE });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/chat\/([a-zA-Z0-9]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const roomId = match[1];

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

  // Room count limit (only for new rooms)
  if (!chatRooms.has(roomId) && chatRooms.size >= MAX_ROOMS) {
    socket.destroy();
    return;
  }

  // Reject if room is full
  const room = chatRooms.get(roomId);
  if (room && room.size >= MAX_ROOM_SIZE) {
    socket.destroy();
    return;
  }

  // Track IP
  ipConnections.set(ip, ipCount + 1);

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, roomId, ip);
  });
});

wss.on('connection', (ws, roomId, ip) => {
  // Assign anonymous peer ID
  const peerId = crypto.randomBytes(2).toString('hex');

  // Add to room
  if (!chatRooms.has(roomId)) chatRooms.set(roomId, new Set());
  const room = chatRooms.get(roomId);
  room.add(ws);

  // Rate limiting state
  let msgCount = 0;
  const rateLimitInterval = setInterval(() => { msgCount = 0; }, 1000);

  // Send init to joining peer
  ws.send(JSON.stringify({ type: 'init', peer: peerId, count: room.size }));

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
