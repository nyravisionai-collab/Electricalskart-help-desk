import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { initDb, run, get, all } from './db.js';
import {
  authenticateStaffToken,
  comparePassword,
  hashPassword,
  requireAuth,
  requireRole,
  signToken,
  validateAuthConfiguration,
} from './auth.js';
import {
  authenticateCustomerSession,
  createCustomerSessionToken,
  customerOwnsConversation,
  customerTokenFromRequest,
  hashCustomerSessionToken,
} from './customer-auth.js';
import { generateReply, suggestReply } from './ai.js';
import { validateAIConfiguration } from './ai-provider.js';
import {
  findVerifiedKnowledge,
  importKnowledgeFile,
  knowledgeEntrySchema,
  listKnowledgeEntries,
  saveKnowledgeEntry,
} from './knowledge.js';
import { buildIceServers } from './webrtc-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3001', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const configuredCorsOrigins = (
  process.env.CORS_ORIGIN || (NODE_ENV === 'development' ? 'http://localhost:5173' : '')
).split(',').map(origin => origin.trim()).filter(Boolean);
const corsOptions = configuredCorsOrigins.length > 0
  ? { origin: configuredCorsOrigins, credentials: false }
  : { origin: false };

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: corsOptions, maxHttpBufferSize: 256 * 1024 });

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: NODE_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      workerSrc: ["'self'", 'blob:'],
    },
  } : false,
}));
app.use(cors(corsOptions));
app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.set('trust proxy', 1);

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false }));

// =====================================================
// Connected peers are ephemeral; call and queue state is database-backed.
// =====================================================
const customers = new Map(); // socketId -> verified { customerId, conversationId, name }
const agents = new Map();    // socketId -> verified { userId, role, name }

const CALL_STATUS = Object.freeze({
  WAITING: 'WAITING',
  RINGING: 'RINGING',
  ACTIVE: 'ACTIVE',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  ENDED: 'ENDED',
  FAILED: 'FAILED',
  MISSED: 'MISSED',
});
const TERMINAL_CALL_STATUSES = new Set([
  CALL_STATUS.REJECTED,
  CALL_STATUS.CANCELLED,
  CALL_STATUS.ENDED,
  CALL_STATUS.FAILED,
  CALL_STATUS.MISSED,
]);
const CALL_TRANSITIONS = Object.freeze({
  [CALL_STATUS.WAITING]: new Set([CALL_STATUS.RINGING, CALL_STATUS.CANCELLED, CALL_STATUS.FAILED, CALL_STATUS.MISSED]),
  [CALL_STATUS.RINGING]: new Set([CALL_STATUS.ACTIVE, CALL_STATUS.REJECTED, CALL_STATUS.CANCELLED, CALL_STATUS.FAILED, CALL_STATUS.MISSED]),
  [CALL_STATUS.ACTIVE]: new Set([CALL_STATUS.ENDED, CALL_STATUS.FAILED]),
});
const CALL_RING_TIMEOUT_MS = Math.max(250, Number.parseInt(process.env.CALL_RING_TIMEOUT_MS || '30000', 10));
const CALL_QUEUE_TTL_MS = Math.max(5_000, Number.parseInt(process.env.CALL_QUEUE_TTL_MS || '900000', 10));
let configuredIceServers = [];
const callRuntime = {
  ringingTimers: new Map(), // callId -> timeout
  peers: new Map(),         // callId -> { customerSocketId, agentSocketId }
};

// =====================================================
// Helpers
// =====================================================
function now() { return Date.now(); }

function sanitize(s, max = 2000) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

const webRtcSignalSchema = z.union([
  z.object({
    type: z.enum(['offer', 'answer']),
    sdp: z.string().min(1).max(200_000),
  }).passthrough(),
  z.object({
    type: z.literal('candidate'),
    candidate: z.object({
      candidate: z.string().max(10_000),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    }).passthrough(),
  }).passthrough(),
]);

function conversationStatus(conversationId) {
  return get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
}

function broadcastDashboard() {
  // Push a summary to all connected agents
  const summary = buildDashboardSummary();
  io.to('agents').emit('dashboard:update', summary);
}

function buildDashboardSummary() {
  const active = all(
    `SELECT c.id as conversation_id, c.status, c.mode, c.created_at, c.updated_at, c.assigned_agent_id,
            cu.id as customer_id, cu.name as customer_name, cu.requirement
     FROM conversations c JOIN customers cu ON cu.id = c.customer_id
     WHERE c.status != 'CLOSED'
     ORDER BY c.updated_at DESC`
  );
  const activeCalls = all(`
    SELECT ca.*, cu.name AS customer_name, cu.requirement
    FROM calls ca JOIN customers cu ON cu.id = ca.customer_id
    WHERE ca.status IN ('WAITING','RINGING','ACTIVE')
    ORDER BY CASE ca.status WHEN 'ACTIVE' THEN 0 WHEN 'RINGING' THEN 1 ELSE 2 END,
             ca.queue_position ASC, ca.started_at ASC
  `);
  const stats = {
    total_conversations: (all('SELECT COUNT(*) as c FROM conversations')[0]?.c) || 0,
    total_calls: (all('SELECT COUNT(*) as c FROM calls')[0]?.c) || 0,
    active_customers: active.length,
    ai_conversations: active.filter(c => c.status === 'AI_ACTIVE').length,
    human_required: active.filter(c => c.status === 'HUMAN_REQUIRED').length,
    human_active: active.filter(c => c.status === 'HUMAN_ACTIVE').length,
    active_calls: activeCalls.filter(call => call.status === CALL_STATUS.ACTIVE).length,
    waiting_calls: activeCalls.filter(call => call.status === CALL_STATUS.WAITING).length,
  };
  return {
    conversations: active,
    calls: activeCalls,
    stats,
    queue: activeCalls.filter(call => call.status === CALL_STATUS.WAITING).length,
    currentCall: activeCalls.some(call => call.status === CALL_STATUS.ACTIVE),
  };
}

function pushMessagesToConversation(conversationId) {
  const msgs = all(
    'SELECT id, sender_type as senderType, sender_id as senderId, message, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
    [conversationId]
  );
  // Send to customer
  for (const [sid, c] of customers.entries()) {
    if (c.conversationId === conversationId) {
      io.to(sid).emit('conversation:messages', msgs);
    }
  }
  // Send to all agents (they may have it open)
  io.to('agents').emit('conversation:messages', { conversationId, messages: msgs });
}

async function generateAIResponseAndPersist(conversationId, expectedRevision) {
  // Every generation is tied to the exact AI-active revision that requested it.
  // A takeover, close, call transition, or newer customer message invalidates it.
  const conv = conversationStatus(conversationId);
  if (!conv || conv.status !== 'AI_ACTIVE' || conv.revision !== expectedRevision) return;

  const msgs = all(
    "SELECT sender_type, message FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
    [conversationId]
  );
  // Build chat history for LLM in {role, content}
  const chatHistory = [];
  for (const m of msgs) {
    if (m.sender_type === 'CUSTOMER') chatHistory.push({ role: 'user', content: m.message });
    else if (m.sender_type === 'AI') chatHistory.push({ role: 'assistant', content: m.message });
    else if (m.sender_type === 'AGENT') chatHistory.push({ role: 'assistant', content: m.message });
    else if (m.sender_type === 'SYSTEM') chatHistory.push({ role: 'system', content: m.message });
  }

  // Mark typing for customer UI
  const customerSid = [...customers.entries()].find(([, c]) => c.conversationId === conversationId)?.[0];
  if (customerSid) io.to(customerSid).emit('ai:typing', true);

  const lastQuestion = [...chatHistory].reverse().find(message => message.role === 'user')?.content || '';
  const verifiedKnowledge = findVerifiedKnowledge(lastQuestion);
  const { text, needsHuman } = await generateReply(chatHistory, verifiedKnowledge);

  if (customerSid) io.to(customerSid).emit('ai:typing', false);

  // Human mode and newer conversation revisions are authoritative. Discard a
  // response that completed after its initiating revision was invalidated.
  const current = conversationStatus(conversationId);
  if (!current || current.status !== 'AI_ACTIVE' || current.revision !== expectedRevision) return;

  // Persist AI message if non-empty
  if (text) {
    const id = 'm_' + nanoid(12);
    run('INSERT INTO messages (id, conversation_id, sender_type, sender_id, message, timestamp) VALUES (?,?,?,?,?,?)',
      [id, conversationId, 'AI', null, text, now()]);
    run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  }

  if (needsHuman) {
    run("UPDATE conversations SET status = 'HUMAN_REQUIRED', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'AI_ACTIVE' AND revision = ?",
      [now(), conversationId, expectedRevision]);
    const sysId = 'm_' + nanoid(12);
    run('INSERT INTO messages (id, conversation_id, sender_type, sender_id, message, timestamp) VALUES (?,?,?,?,?,?)',
      [sysId, conversationId, 'SYSTEM', null, 'Connecting you to a support representative…', now()]);
    if (customerSid) io.to(customerSid).emit('conversation:status', { status: 'HUMAN_REQUIRED' });
    io.to('agents').emit('alert:human_required', {
      conversationId,
      customer: get('SELECT id, name, requirement FROM customers WHERE id = ?',
        [conv.customer_id]),
    });
  }

  pushMessagesToConversation(conversationId);
  broadcastDashboard();
}

// =====================================================
// Auth REST
// =====================================================
app.post('/api/auth/login', (req, res) => {
  const schema = z.object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { email, password } = parsed.data;
  const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Invalid credentials' });
  if (!comparePassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Owner: create additional agent accounts
app.post('/api/agents', requireAuth, requireRole('owner'), (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254),
    password: z.string().min(12).max(128),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { name, email, password } = parsed.data;
  const exists = get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (exists) return res.status(409).json({ error: 'User already exists' });
  const id = 'u_' + nanoid(12);
  run('INSERT INTO users (id,name,email,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?)',
    [id, name, email.toLowerCase(), hashPassword(password), 'agent', 'active', now()]);
  res.json({ id, name, email: email.toLowerCase(), role: 'agent' });
});

app.get('/api/agents', requireAuth, requireRole('owner'), (req, res) => {
  const rows = all('SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at ASC');
  res.json({ agents: rows });
});

// Verified business knowledge. Agents may read the facts they support from;
// only the Owner can create, update, activate, or deactivate entries.
app.get('/api/knowledge', requireAuth, (req, res) => {
  res.json({ entries: listKnowledgeEntries() });
});

app.post('/api/knowledge', requireAuth, requireRole('owner'), (req, res) => {
  const parsed = knowledgeEntrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid verified knowledge entry' });
  const entry = saveKnowledgeEntry(parsed.data, req.user.uid);
  return res.status(parsed.data.id ? 200 : 201).json({ entry });
});

app.delete('/api/knowledge/:id', requireAuth, requireRole('owner'), (req, res) => {
  const existing = get('SELECT id FROM knowledge_entries WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Knowledge entry not found' });
  run(
    'UPDATE knowledge_entries SET is_active = 0, updated_at = ?, updated_by = ? WHERE id = ?',
    [now(), req.user.uid, req.params.id],
  );
  return res.status(204).end();
});

// =====================================================
// Customer REST (public)
// =====================================================
// Start a new customer session or resume one by presenting its opaque secret.
// Browser-supplied customer/conversation identifiers are never accepted here.
app.post('/api/customer/start', (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(80),
    requirement: z.string().trim().min(1).max(500),
    customerToken: z.string().max(256).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please provide your name and your question.' });
  const { name, requirement } = parsed.data;

  let customerToken = parsed.data.customerToken || '';
  let customer = customerToken ? authenticateCustomerSession(customerToken) : null;
  if (customerToken && !customer) {
    return res.status(401).json({ error: 'Customer session is invalid or expired. Start a new chat.' });
  }

  if (!customer) {
    const id = 'cu_' + nanoid(12);
    const sessionId = 'sess_' + nanoid(24); // non-secret internal correlation id
    customerToken = createCustomerSessionToken();
    const tokenHash = hashCustomerSessionToken(customerToken);
    run(
      'INSERT INTO customers (id,name,session_id,session_token_hash,requirement,created_at,last_active_at) VALUES (?,?,?,?,?,?,?)',
      [id, sanitize(name, 80), sessionId, tokenHash, sanitize(requirement, 500), now(), now()],
    );
    customer = get('SELECT * FROM customers WHERE id = ?', [id]);
  } else {
    run(
      'UPDATE customers SET name = ?, requirement = ?, last_active_at = ? WHERE id = ?',
      [sanitize(name, 80), sanitize(requirement, 500), now(), customer.id],
    );
    customer = get('SELECT * FROM customers WHERE id = ?', [customer.id]);
  }

  // Find an open conversation for this verified customer, or create one.
  let convo = get("SELECT * FROM conversations WHERE customer_id = ? AND status != 'CLOSED' ORDER BY updated_at DESC LIMIT 1", [customer.id]);
  if (!convo) {
    const id = 'co_' + nanoid(12);
    run('INSERT INTO conversations (id,customer_id,status,mode,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [id, customer.id, 'AI_ACTIVE', 'ai', now(), now()]);
    const welcomeId = 'm_' + nanoid(12);
    run('INSERT INTO messages (id,conversation_id,sender_type,sender_id,message,timestamp) VALUES (?,?,?,?,?,?)',
      [welcomeId, id, 'SYSTEM', null, 'You are now chatting with Electricalskart Support. AI assistant is online — type your question or click "Call Now" to speak with a person.', now()]);
    if (customer.requirement) {
      const reqId = 'm_' + nanoid(12);
      run('INSERT INTO messages (id,conversation_id,sender_type,sender_id,message,timestamp) VALUES (?,?,?,?,?,?)',
        [reqId, id, 'CUSTOMER', customer.id, customer.requirement, now()]);
    }
    convo = get('SELECT * FROM conversations WHERE id = ?', [id]);
    setTimeout(() => generateAIResponseAndPersist(id, convo.revision), 400);
  }

  res.json({
    customerToken,
    conversationId: convo.id,
    customerName: customer.name,
    status: convo.status,
  });
});

// Conversation history is available to authenticated staff or to the verified
// customer session that owns the requested conversation.
app.get('/api/conversations/:id/messages', (req, res) => {
  const convId = req.params.id;
  const conv = get('SELECT * FROM conversations WHERE id = ?', [convId]);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const staff = bearer ? authenticateStaffToken(bearer) : null;
  const customer = authenticateCustomerSession(customerTokenFromRequest(req));
  const staffAllowed = Boolean(staff);
  const customerAllowed = customer && conv.customer_id === customer.id;
  if (!staffAllowed && !customerAllowed) {
    return res.status(customer || staff ? 403 : 401).json({ error: 'Not authorized for this conversation' });
  }

  const msgs = all(
    'SELECT id, sender_type as senderType, sender_id as senderId, message, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
    [convId],
  );
  const conversationCustomer = get('SELECT name, requirement FROM customers WHERE id = ?', [conv.customer_id]);
  res.json({ conversation: conv, customer: conversationCustomer, messages: msgs });
});

// =====================================================
// Agent REST (authenticated)
// =====================================================
app.get('/api/dashboard/summary', requireAuth, (req, res) => {
  res.json(buildDashboardSummary());
});

app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = all(`
    SELECT c.*, cu.name as customer_name, cu.requirement, cu.last_active_at
    FROM conversations c JOIN customers cu ON cu.id = c.customer_id
    ORDER BY c.updated_at DESC LIMIT 200
  `);
  res.json({ conversations: rows });
});

app.get('/api/customers', requireAuth, (req, res) => {
  const rows = all(`
    SELECT cu.*,
      (SELECT COUNT(*) FROM conversations c WHERE c.customer_id = cu.id) as conversation_count,
      (SELECT COUNT(*) FROM calls ca WHERE ca.customer_id = cu.id) as call_count,
      (SELECT MAX(c.updated_at) FROM conversations c WHERE c.customer_id = cu.id) as last_conversation_at
    FROM customers cu
    ORDER BY cu.last_active_at DESC LIMIT 500
  `);
  res.json({ customers: rows });
});

app.get('/api/calls/history', requireAuth, (req, res) => {
  const rows = all(`
    SELECT ca.*, cu.name as customer_name, u.name as handled_by_name
    FROM calls ca
    JOIN customers cu ON cu.id = ca.customer_id
    LEFT JOIN users u ON u.id = ca.handled_by
    ORDER BY ca.started_at DESC LIMIT 200
  `);
  res.json({ calls: rows });
});

app.get('/api/calls/:id', requireAuth, (req, res) => {
  const call = get('SELECT * FROM calls WHERE id = ?', [req.params.id]);
  if (!call) return res.status(404).json({ error: 'Not found' });
  res.json({ call });
});

// =====================================================
// Socket.IO
// =====================================================
io.use((socket, next) => {
  // Two types of sockets: customers (no auth) and agents (bearer token).
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
  const role = socket.handshake.auth?.role; // 'agent' or 'customer'
  if (role === 'agent') {
    if (!token) return next(new Error('Authentication required'));
    const user = authenticateStaffToken(token);
    if (!user) return next(new Error('Invalid token'));
    socket.data.user = user;
    return next();
  }
  if (role === 'customer') {
    const customer = authenticateCustomerSession(token);
    if (!customer) return next(new Error('Invalid customer session'));
    // Identity comes exclusively from the verified opaque session token.
    socket.data.customer = {
      customerId: customer.id,
      name: customer.name,
    };
    return next();
  }
  return next(new Error('Unknown connection role'));
});

io.on('connection', (socket) => {
  socket.emit('webrtc:config', { iceServers: configuredIceServers });
  if (socket.data.user) {
    // ---------- AGENT ----------
    const u = socket.data.user;
    agents.set(socket.id, { userId: u.uid, role: u.role, name: u.name });
    socket.join('agents');
    socket.emit('auth:ok', { user: u });
    socket.emit('dashboard:update', buildDashboardSummary());
    io.to('agents').emit('agents:presence', [...agents.values()]);
    promoteNextWaitingCall();

    socket.on('conversation:open', ({ conversationId }) => {
      const msgs = all(
        'SELECT id, sender_type as senderType, sender_id as senderId, message, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
        [conversationId]
      );
      socket.emit('conversation:messages', { conversationId, messages: msgs });
    });

    socket.on('conversation:takeover', ({ conversationId }) => {
      const conv = get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
      if (!conv) return;
      run(
        "UPDATE calls SET previous_conversation_status = 'HUMAN_ACTIVE', previous_conversation_mode = 'human', updated_at = ? WHERE conversation_id = ? AND status IN ('WAITING','RINGING','ACTIVE')",
        [now(), conversationId],
      );
      run("UPDATE conversations SET status = 'HUMAN_ACTIVE', mode = 'human', assigned_agent_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        [u.uid, now(), conversationId]);
      const sysId = 'm_' + nanoid(12);
      run('INSERT INTO messages (id,conversation_id,sender_type,sender_id,message,timestamp) VALUES (?,?,?,?,?,?)',
        [sysId, conversationId, 'SYSTEM', u.uid, `${u.name} has joined the chat.`, now()]);
      // Notify customer
      for (const [sid, c] of customers.entries()) {
        if (c.conversationId === conversationId) {
          io.to(sid).emit('conversation:status', { status: 'HUMAN_ACTIVE', agentName: u.name });
        }
      }
      pushMessagesToConversation(conversationId);
      broadcastDashboard();
    });

    socket.on('conversation:close', ({ conversationId }) => {
      run("UPDATE conversations SET status = 'CLOSED', revision = revision + 1, updated_at = ? WHERE id = ?", [now(), conversationId]);
      const sysId = 'm_' + nanoid(12);
      run('INSERT INTO messages (id,conversation_id,sender_type,sender_id,message,timestamp) VALUES (?,?,?,?,?,?)',
        [sysId, conversationId, 'SYSTEM', u.uid, 'Conversation closed by agent.', now()]);
      for (const [sid, c] of customers.entries()) {
        if (c.conversationId === conversationId) {
          io.to(sid).emit('conversation:status', { status: 'CLOSED' });
        }
      }
      pushMessagesToConversation(conversationId);
      broadcastDashboard();
    });

    socket.on('agent:message', async ({ conversationId, message }) => {
      const text = sanitize(message);
      if (!text) return;
      const conv = get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
      if (!conv) return;
      // If in AI mode, auto-takeover on first agent message
      if (conv.status !== 'HUMAN_ACTIVE') {
        run(
          "UPDATE calls SET previous_conversation_status = 'HUMAN_ACTIVE', previous_conversation_mode = 'human', updated_at = ? WHERE conversation_id = ? AND status IN ('WAITING','RINGING','ACTIVE')",
          [now(), conversationId],
        );
        run("UPDATE conversations SET status = 'HUMAN_ACTIVE', mode = 'human', assigned_agent_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
          [u.uid, now(), conversationId]);
      } else {
        run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
      }
      const id = 'm_' + nanoid(12);
      run('INSERT INTO messages (id,conversation_id,sender_type,sender_id,message,timestamp) VALUES (?,?,?,?,?,?)',
        [id, conversationId, 'AGENT', u.uid, text, now()]);
      for (const [sid, c] of customers.entries()) {
        if (c.conversationId === conversationId) {
          io.to(sid).emit('conversation:status', { status: 'HUMAN_ACTIVE', agentName: u.name });
        }
      }
      pushMessagesToConversation(conversationId);
      broadcastDashboard();
    });

    socket.on('agent:suggest', async ({ conversationId }, ack) => {
      const msgs = all('SELECT sender_type, message FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC', [conversationId]);
      const history = msgs.map(m => ({
        role: m.sender_type === 'CUSTOMER' ? 'user' :
              m.sender_type === 'SYSTEM' ? 'system' : 'assistant',
        content: m.message,
      }));
      const lastQuestion = [...history].reverse().find(message => message.role === 'user')?.content || '';
      const suggestion = await suggestReply(history, findVerifiedKnowledge(lastQuestion));
      if (ack) ack({ suggestion }); else socket.emit('agent:suggestion', { conversationId, suggestion });
    });

    // ---------- Call handling (agent side) ----------
    socket.on('call:accept', (payload, ack) => {
      const parsed = z.object({ callId: z.string().min(1).max(100) }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_REQUEST' });
      const { callId } = parsed.data;
      const call = getCall(callId);
      if (!call || call.status !== CALL_STATUS.RINGING) {
        socket.emit('call:taken', { callId });
        return ack?.({ ok: false, error: 'CALL_NOT_RINGING' });
      }
      if (get("SELECT id FROM calls WHERE status = 'ACTIVE' LIMIT 1")) {
        return ack?.({ ok: false, error: 'ANOTHER_CALL_ACTIVE' });
      }
      const customerSocketId = connectedCustomerSocket(call.customer_id, call.conversation_id);
      if (!customerSocketId) {
        completeCall(callId, CALL_STATUS.FAILED, 'customer_unavailable', 'call:ended');
        return ack?.({ ok: false, error: 'CUSTOMER_UNAVAILABLE' });
      }

      const acceptedAt = now();
      const transitioned = transitionCall(callId, CALL_STATUS.ACTIVE, {
        answered_at: acceptedAt,
        handled_by: u.uid,
        expires_at: null,
      });
      if (!transitioned.ok) return ack?.({ ok: false, error: transitioned.error });
      clearRingingTimer(callId);
      run(
        "UPDATE conversations SET status = 'IN_CALL', revision = revision + 1, updated_at = ? WHERE id = ?",
        [acceptedAt, call.conversation_id],
      );
      emitConversationStatus(call.conversation_id, 'IN_CALL');
      callRuntime.peers.set(callId, { customerSocketId, agentSocketId: socket.id });

      io.to('agents').emit('call:taken', { callId, handledBy: u.uid, handledByName: u.name });
      io.to(customerSocketId).emit('call:accepted', { callId, agentSocketId: socket.id });
      socket.emit('call:accepted', { callId, customerSocketId });
      ack?.({ ok: true, callId, customerSocketId });
      broadcastDashboard();
    });

    socket.on('call:reject', (payload, ack) => {
      const parsed = z.object({ callId: z.string().min(1).max(100) }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_REQUEST' });
      const call = getCall(parsed.data.callId);
      if (!call || call.status !== CALL_STATUS.RINGING) {
        return ack?.({ ok: false, error: 'CALL_NOT_RINGING' });
      }
      const result = completeCall(call.id, CALL_STATUS.REJECTED, 'agent_rejected', 'call:rejected');
      ack?.({ ok: result.ok, error: result.error });
    });

    socket.on('call:hangup', (payload, ack) => {
      const parsed = z.object({ callId: z.string().min(1).max(100) }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_REQUEST' });
      const call = getCall(parsed.data.callId);
      const peers = callRuntime.peers.get(parsed.data.callId);
      if (!call || call.status !== CALL_STATUS.ACTIVE || call.handled_by !== u.uid || peers?.agentSocketId !== socket.id) {
        return ack?.({ ok: false, error: 'NOT_CALL_OWNER' });
      }
      const result = completeCall(call.id, CALL_STATUS.ENDED, 'agent_hangup');
      ack?.({ ok: result.ok, error: result.error });
    });

    socket.on('call:failed', (payload, ack) => {
      const parsed = z.object({
        callId: z.string().min(1).max(100),
        reason: z.string().trim().min(1).max(100),
      }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_REQUEST' });
      const call = getCall(parsed.data.callId);
      const peers = callRuntime.peers.get(parsed.data.callId);
      if (!call || call.status !== CALL_STATUS.ACTIVE || call.handled_by !== u.uid || peers?.agentSocketId !== socket.id) {
        return ack?.({ ok: false, error: 'NOT_CALL_OWNER' });
      }
      const result = completeCall(call.id, CALL_STATUS.FAILED, `webrtc_${parsed.data.reason}`);
      ack?.({ ok: result.ok, error: result.error });
    });

    // WebRTC signaling is relayed only between the two verified active-call peers.
    socket.on('webrtc:signal', (payload) => {
      const parsed = z.object({
        to: z.string().min(1).max(100),
        signal: webRtcSignalSchema,
      }).safeParse(payload);
      if (!parsed.success) return;
      const peer = [...callRuntime.peers.values()].find(value => value.agentSocketId === socket.id);
      if (peer && parsed.data.to === peer.customerSocketId) {
        io.to(parsed.data.to).emit('webrtc:signal', { from: socket.id, signal: parsed.data.signal });
      }
    });

    socket.on('disconnect', () => {
      agents.delete(socket.id);
      io.to('agents').emit('agents:presence', [...agents.values()]);
      const ownedCall = [...callRuntime.peers.entries()].find(([, peers]) => peers.agentSocketId === socket.id);
      if (ownedCall) completeCall(ownedCall[0], CALL_STATUS.FAILED, 'agent_disconnected');
      // An unrelated agent disconnecting never changes an unclaimed ringing call.
      broadcastDashboard();
    });
  } else {
    // ---------- CUSTOMER ----------
    // The middleware has already derived this identity from the opaque session
    // token. A socket receives no conversation events until a verified bind.
    const verifiedCustomer = socket.data.customer;

    socket.on('customer:bind', (payload, ack) => {
      const parsed = z.object({ conversationId: z.string().min(1).max(100) }).safeParse(payload);
      if (!parsed.success) {
        const error = { code: 'INVALID_REQUEST', message: 'Invalid conversation request' };
        socket.emit('customer:error', error);
        return ack?.({ ok: false, error });
      }
      const { conversationId } = parsed.data;
      const conv = customerOwnsConversation(verifiedCustomer.customerId, conversationId);
      if (!conv) {
        const error = { code: 'FORBIDDEN', message: 'Conversation does not belong to this customer session' };
        socket.emit('customer:error', error);
        return ack?.({ ok: false, error });
      }

      const previous = customers.get(socket.id);
      if (previous?.conversationId) socket.leave(`customer-conversation:${previous.conversationId}`);
      customers.set(socket.id, {
        customerId: verifiedCustomer.customerId,
        conversationId,
        name: verifiedCustomer.name,
      });
      socket.join(`customer-conversation:${conversationId}`);
      run('UPDATE customers SET last_active_at = ? WHERE id = ?', [now(), verifiedCustomer.customerId]);
      socket.emit('conversation:status', { status: conv.status });
      const msgs = all(
        'SELECT id, sender_type as senderType, sender_id as senderId, message, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
        [conversationId],
      );
      socket.emit('conversation:messages', msgs);
      const existingCall = get(
        "SELECT * FROM calls WHERE customer_id = ? AND conversation_id = ? AND status IN ('WAITING','RINGING','ACTIVE') ORDER BY started_at DESC LIMIT 1",
        [verifiedCustomer.customerId, conversationId],
      );
      if (existingCall?.status === CALL_STATUS.WAITING) {
        socket.emit('call:queued', { callId: existingCall.id, position: existingCall.queue_position });
      } else if (existingCall?.status === CALL_STATUS.RINGING) {
        socket.emit('call:ringing', { callId: existingCall.id });
      }
      ack?.({ ok: true, conversationId });
      promoteNextWaitingCall();
      return;
    });

    socket.on('customer:message', (payload, ack) => {
      const parsed = z.object({
        conversationId: z.string().min(1).max(100),
        message: z.string().trim().min(1).max(2000),
      }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: { code: 'INVALID_REQUEST' } });
      const { conversationId, message } = parsed.data;
      const cdata = customers.get(socket.id);
      const conv = customerOwnsConversation(verifiedCustomer.customerId, conversationId);
      if (!cdata || cdata.conversationId !== conversationId || !conv) {
        const error = { code: 'FORBIDDEN', message: 'Conversation does not belong to this customer session' };
        socket.emit('customer:error', error);
        return ack?.({ ok: false, error });
      }

      const text = sanitize(message);
      run('UPDATE customers SET last_active_at = ? WHERE id = ?', [now(), verifiedCustomer.customerId]);
      run('UPDATE conversations SET revision = revision + 1, updated_at = ? WHERE id = ?', [now(), conversationId]);
      const updatedConversation = conversationStatus(conversationId);
      const id = 'm_' + nanoid(12);
      run('INSERT INTO messages (id,conversation_id,sender_type,sender_id,message,timestamp) VALUES (?,?,?,?,?,?)',
        [id, conversationId, 'CUSTOMER', verifiedCustomer.customerId, text, now()]);
      pushMessagesToConversation(conversationId);
      broadcastDashboard();
      ack?.({ ok: true, messageId: id });

      if (updatedConversation?.status === 'AI_ACTIVE') {
        setTimeout(
          () => generateAIResponseAndPersist(conversationId, updatedConversation.revision),
          100,
        );
      }
    });

    // ---------- Customer initiates call ----------
    socket.on('call:request', (payload, ack) => {
      const parsed = z.object({ conversationId: z.string().min(1).max(100) }).safeParse(payload);
      if (!parsed.success) {
        socket.emit('call:error', { message: 'Invalid call request.' });
        return ack?.({ ok: false, error: 'INVALID_REQUEST' });
      }
      const { conversationId } = parsed.data;
      const bound = customers.get(socket.id);
      const conversation = customerOwnsConversation(verifiedCustomer.customerId, conversationId);
      if (!bound || bound.conversationId !== conversationId || !conversation) {
        socket.emit('call:error', { message: 'Not authorized for this conversation.' });
        return ack?.({ ok: false, error: 'FORBIDDEN' });
      }
      const existing = get(
        "SELECT * FROM calls WHERE customer_id = ? AND status IN ('WAITING','RINGING','ACTIVE') LIMIT 1",
        [verifiedCustomer.customerId],
      );
      if (existing) {
        socket.emit('call:error', { message: 'You already have a pending or active call.' });
        return ack?.({ ok: false, error: 'DUPLICATE_CALL', callId: existing.id });
      }
      if (!['AI_ACTIVE', 'HUMAN_REQUIRED', 'HUMAN_ACTIVE'].includes(conversation.status)) {
        socket.emit('call:error', { message: 'A call cannot be started from the current conversation state.' });
        return ack?.({ ok: false, error: 'INVALID_CONVERSATION_STATE' });
      }

      const callId = 'ca_' + nanoid(12);
      const requestedAt = now();
      const waitingCount = get("SELECT COUNT(*) AS count FROM calls WHERE status = 'WAITING'")?.count || 0;
      run(
        `INSERT INTO calls (
          id, customer_id, conversation_id, status, queue_position, started_at,
          previous_conversation_status, previous_conversation_mode, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          callId,
          verifiedCustomer.customerId,
          conversationId,
          CALL_STATUS.WAITING,
          waitingCount + 1,
          requestedAt,
          conversation.status,
          conversation.mode,
          requestedAt + CALL_QUEUE_TTL_MS,
          requestedAt,
        ],
      );
      run(
        "UPDATE conversations SET status = 'WAITING_CALL', revision = revision + 1, updated_at = ? WHERE id = ?",
        [requestedAt, conversationId],
      );
      emitConversationStatus(conversationId, 'WAITING_CALL');
      socket.emit('call:queued', { callId, position: waitingCount + 1 });
      io.to('agents').emit('call:queued', {
        callId,
        customerName: verifiedCustomer.name,
        position: waitingCount + 1,
        customer: get('SELECT name, requirement FROM customers WHERE id = ?', [verifiedCustomer.customerId]),
        conversationId,
      });
      ack?.({ ok: true, callId, position: waitingCount + 1 });
      updateQueuePositions();
      broadcastDashboard();
      promoteNextWaitingCall();
    });

    socket.on('call:hangup', (payload, ack) => {
      const parsed = z.object({ callId: z.string().min(1).max(100) }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_REQUEST' });
      const call = getCall(parsed.data.callId);
      const peers = callRuntime.peers.get(parsed.data.callId);
      if (!call || call.customer_id !== verifiedCustomer.customerId || call.status !== CALL_STATUS.ACTIVE || peers?.customerSocketId !== socket.id) {
        return ack?.({ ok: false, error: 'NOT_CALL_OWNER' });
      }
      const result = completeCall(call.id, CALL_STATUS.ENDED, 'customer_hangup');
      ack?.({ ok: result.ok, error: result.error });
    });

    socket.on('call:failed', (payload, ack) => {
      const parsed = z.object({
        callId: z.string().min(1).max(100),
        reason: z.string().trim().min(1).max(100),
      }).safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_REQUEST' });
      const call = getCall(parsed.data.callId);
      const peers = callRuntime.peers.get(parsed.data.callId);
      if (!call || call.customer_id !== verifiedCustomer.customerId || call.status !== CALL_STATUS.ACTIVE || peers?.customerSocketId !== socket.id) {
        return ack?.({ ok: false, error: 'NOT_CALL_OWNER' });
      }
      const result = completeCall(call.id, CALL_STATUS.FAILED, `webrtc_${parsed.data.reason}`);
      ack?.({ ok: result.ok, error: result.error });
    });

    socket.on('call:cancel', (_payload, ack) => {
      const call = get(
        "SELECT * FROM calls WHERE customer_id = ? AND status IN ('WAITING','RINGING') ORDER BY started_at DESC LIMIT 1",
        [verifiedCustomer.customerId],
      );
      if (!call) return ack?.({ ok: false, error: 'NO_CANCELLABLE_CALL' });
      const result = completeCall(call.id, CALL_STATUS.CANCELLED, 'customer_cancel', 'call:cancelled');
      ack?.({ ok: result.ok, error: result.error });
    });

    // WebRTC signaling (customer) — active call peer only.
    socket.on('webrtc:signal', (payload) => {
      const parsed = z.object({
        to: z.string().min(1).max(100),
        signal: webRtcSignalSchema,
      }).safeParse(payload);
      if (!parsed.success) return;
      const peer = [...callRuntime.peers.values()].find(value => value.customerSocketId === socket.id);
      if (peer && parsed.data.to === peer.agentSocketId) {
        io.to(parsed.data.to).emit('webrtc:signal', { from: socket.id, signal: parsed.data.signal });
      }
    });

    socket.on('disconnect', () => {
      customers.delete(socket.id);
      const active = [...callRuntime.peers.entries()].find(([, peers]) => peers.customerSocketId === socket.id);
      if (active) completeCall(active[0], CALL_STATUS.FAILED, 'customer_disconnected');

      const ringing = get(
        "SELECT * FROM calls WHERE customer_id = ? AND status = 'RINGING' ORDER BY started_at DESC LIMIT 1",
        [verifiedCustomer.customerId],
      );
      if (ringing && connectedCustomerSockets(verifiedCustomer.customerId, ringing.conversation_id).length === 0) {
        completeCall(ringing.id, CALL_STATUS.FAILED, 'customer_disconnected', 'call:ended');
      }
      // WAITING calls remain persisted and recover when this customer reconnects.
      broadcastDashboard();
    });
  }
});

function getCall(callId) {
  return get('SELECT * FROM calls WHERE id = ?', [callId]);
}

function connectedCustomerSockets(customerId, conversationId = null) {
  return [...customers.entries()]
    .filter(([, customer]) => customer.customerId === customerId && (!conversationId || customer.conversationId === conversationId))
    .map(([socketId]) => socketId);
}

function connectedCustomerSocket(customerId, conversationId) {
  return connectedCustomerSockets(customerId, conversationId)[0] || null;
}

function emitConversationStatus(conversationId, status) {
  for (const [socketId, customer] of customers.entries()) {
    if (customer.conversationId === conversationId) io.to(socketId).emit('conversation:status', { status });
  }
}

function clearRingingTimer(callId) {
  const timer = callRuntime.ringingTimers.get(callId);
  if (timer) clearTimeout(timer);
  callRuntime.ringingTimers.delete(callId);
}

function transitionCall(callId, nextStatus, updates = {}) {
  const current = getCall(callId);
  if (!current) return { ok: false, error: 'NOT_FOUND' };
  if (current.status === nextStatus) return { ok: true, call: current };
  if (TERMINAL_CALL_STATUSES.has(current.status)) return { ok: false, error: 'TERMINAL', call: current };
  if (!CALL_TRANSITIONS[current.status]?.has(nextStatus)) {
    return { ok: false, error: `INVALID_TRANSITION_${current.status}_TO_${nextStatus}`, call: current };
  }

  const changedAt = now();
  const next = {
    ...current,
    ...updates,
    status: nextStatus,
    updated_at: changedAt,
  };
  run(
    `UPDATE calls SET status = ?, queue_position = ?, ringing_at = ?, answered_at = ?, ended_at = ?,
       duration = ?, handled_by = ?, end_reason = ?, expires_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      next.status,
      next.queue_position ?? 0,
      next.ringing_at,
      next.answered_at,
      next.ended_at,
      next.duration ?? 0,
      next.handled_by,
      next.end_reason,
      next.expires_at,
      next.updated_at,
      callId,
    ],
  );
  return { ok: true, call: getCall(callId), previousStatus: current.status };
}

function restoreConversationForCall(call) {
  const conversation = conversationStatus(call.conversation_id);
  if (!conversation || !['WAITING_CALL', 'IN_CALL'].includes(conversation.status)) return;
  const validPrevious = ['AI_ACTIVE', 'HUMAN_REQUIRED', 'HUMAN_ACTIVE'].includes(call.previous_conversation_status)
    ? call.previous_conversation_status
    : (call.previous_conversation_mode === 'human' ? 'HUMAN_ACTIVE' : 'AI_ACTIVE');
  const previousMode = call.previous_conversation_mode === 'human' ? 'human' : 'ai';
  run(
    'UPDATE conversations SET status = ?, mode = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    [validPrevious, previousMode, now(), call.conversation_id],
  );
  emitConversationStatus(call.conversation_id, validPrevious);
}

function updateQueuePositions() {
  const waiting = all(
    `SELECT ca.*, cu.name AS customer_name
     FROM calls ca JOIN customers cu ON cu.id = ca.customer_id
     WHERE ca.status = 'WAITING'
     ORDER BY ca.started_at ASC, ca.id ASC`,
  );
  waiting.forEach((call, index) => {
    const position = index + 1;
    if (call.queue_position !== position) {
      run('UPDATE calls SET queue_position = ?, updated_at = ? WHERE id = ?', [position, now(), call.id]);
    }
    for (const socketId of connectedCustomerSockets(call.customer_id, call.conversation_id)) {
      io.to(socketId).emit('call:queued', { callId: call.id, position });
    }
  });
  io.to('agents').emit('call:queue_update', waiting.map((call, index) => ({
    callId: call.id,
    customerName: call.customer_name,
    position: index + 1,
  })));
  return waiting;
}

function completeCall(callId, finalStatus, reason, customerEvent = 'call:ended', options = {}) {
  const current = getCall(callId);
  if (!current) return { ok: false, error: 'NOT_FOUND' };
  const endedAt = now();
  const duration = current.answered_at
    ? Math.max(0, Math.round((endedAt - current.answered_at) / 1000))
    : 0;
  const result = transitionCall(callId, finalStatus, {
    queue_position: 0,
    ended_at: endedAt,
    duration,
    end_reason: reason,
    expires_at: null,
  });
  if (!result.ok) return result;

  clearRingingTimer(callId);
  const peers = callRuntime.peers.get(callId);
  callRuntime.peers.delete(callId);
  restoreConversationForCall(result.call);

  const payload = { callId, duration, reason, status: finalStatus };
  for (const socketId of connectedCustomerSockets(result.call.customer_id, result.call.conversation_id)) {
    io.to(socketId).emit(customerEvent, payload);
  }
  if (peers?.agentSocketId) io.to(peers.agentSocketId).emit('call:ended', payload);
  io.to('agents').emit('call:resolved', payload);
  updateQueuePositions();
  broadcastDashboard();
  if (options.promote !== false) promoteNextWaitingCall();
  return result;
}

function expireWaitingCalls() {
  const expired = all(
    "SELECT id FROM calls WHERE status = 'WAITING' AND expires_at IS NOT NULL AND expires_at <= ?",
    [now()],
  );
  for (const call of expired) {
    completeCall(call.id, CALL_STATUS.MISSED, 'queue_expired', 'call:rejected', { promote: false });
  }
}

function promoteNextWaitingCall() {
  if (agents.size === 0) return updateQueuePositions();
  const blocking = get("SELECT id FROM calls WHERE status IN ('RINGING','ACTIVE') LIMIT 1");
  if (blocking) return updateQueuePositions();
  expireWaitingCalls();

  const waiting = updateQueuePositions();
  const next = waiting.find(call => connectedCustomerSocket(call.customer_id, call.conversation_id));
  if (!next) return;
  const customerSocketId = connectedCustomerSocket(next.customer_id, next.conversation_id);
  const transitioned = transitionCall(next.id, CALL_STATUS.RINGING, {
    queue_position: 0,
    ringing_at: now(),
    expires_at: now() + CALL_RING_TIMEOUT_MS,
  });
  if (!transitioned.ok) return;

  const timeout = setTimeout(() => {
    const call = getCall(next.id);
    if (call?.status === CALL_STATUS.RINGING) {
      completeCall(next.id, CALL_STATUS.MISSED, 'ring_timeout', 'call:rejected');
    }
  }, CALL_RING_TIMEOUT_MS);
  callRuntime.ringingTimers.set(next.id, timeout);

  const customer = get('SELECT name, requirement FROM customers WHERE id = ?', [next.customer_id]);
  const messages = all(
    'SELECT id, sender_type as senderType, message, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
    [next.conversation_id],
  );
  io.to('agents').emit('call:incoming', {
    callId: next.id,
    customer,
    conversationId: next.conversation_id,
    messages,
  });
  io.to(customerSocketId).emit('call:ringing', { callId: next.id });
  updateQueuePositions();
  broadcastDashboard();
}

function reconcileCallsAfterStartup() {
  const stale = all("SELECT id FROM calls WHERE status IN ('RINGING','ACTIVE')");
  for (const call of stale) {
    completeCall(call.id, CALL_STATUS.FAILED, 'server_restart', 'call:ended', { promote: false });
  }
  expireWaitingCalls();
  const waiting = updateQueuePositions();
  if (stale.length || waiting.length) {
    console.log(`[calls] Reconciled ${stale.length} stale and ${waiting.length} waiting call(s).`);
  }
}

// =====================================================
// Serve the React app in production
// =====================================================
if (NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  // In dev the Vite dev server serves the client; this is a sanity endpoint.
  app.get('/', (req, res) => res.send('Electricalskart Help Desk API running. Start the Vite client for UI (npm run dev).'));
}

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start
(async () => {
  try {
    validateAuthConfiguration();
    validateAIConfiguration();
    configuredIceServers = buildIceServers();
    await initDb();
    await importKnowledgeFile();
    reconcileCallsAfterStartup();
    server.listen(PORT, () => {
      console.log(`[server] Electricalskart Help Desk listening on port ${PORT} (${NODE_ENV})`);
    });
  } catch (error) {
    console.error(`[startup] Configuration error: ${error.message}`);
    process.exitCode = 1;
  }
})();
