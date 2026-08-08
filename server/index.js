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
const io = new IOServer(server, { cors: corsOptions });

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
// In-memory state (call queue, active sockets)
// =====================================================
const customers = new Map();       // socketId -> { customerId, conversationId }
const agents = new Map();          // socketId -> { userId, role, name }
const callState = {
  currentCall: null,               // { callId, customerSocketId, agentSocketId, startedAt }
  queue: [],                       // [{ callId, customerId, conversationId, customerName, customerSocketId, enqueuedAt }]
  ringing: null,                   // { callId, customerSocketId, timeout }
};

// =====================================================
// Helpers
// =====================================================
function now() { return Date.now(); }

function sanitize(s, max = 2000) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

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
  const activeCalls = all(`SELECT * FROM calls WHERE status IN ('ringing','in_queue','active') ORDER BY started_at ASC`);
  const stats = {
    total_conversations: (all('SELECT COUNT(*) as c FROM conversations')[0]?.c) || 0,
    total_calls: (all("SELECT COUNT(*) as c FROM calls WHERE status IN ('active','ended')")[0]?.c) || 0,
    active_customers: active.length,
    ai_conversations: active.filter(c => c.status === 'AI_ACTIVE').length,
    human_required: active.filter(c => c.status === 'HUMAN_REQUIRED').length,
    human_active: active.filter(c => c.status === 'HUMAN_ACTIVE').length,
    active_calls: activeCalls.filter(c => c.status === 'active').length,
    waiting_calls: activeCalls.filter(c => c.status === 'in_queue').length,
  };
  return { conversations: active, calls: activeCalls, stats, queue: callState.queue.length, currentCall: !!callState.currentCall };
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
  if (socket.data.user) {
    // ---------- AGENT ----------
    const u = socket.data.user;
    agents.set(socket.id, { userId: u.uid, role: u.role, name: u.name });
    socket.join('agents');
    socket.emit('auth:ok', { user: u });
    socket.emit('dashboard:update', buildDashboardSummary());
    io.to('agents').emit('agents:presence', [...agents.values()]);

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
    socket.on('call:accept', ({ callId }) => {
      if (!callState.ringing || callState.ringing.callId !== callId) return;
      // Cannot accept if already in a call
      if (callState.currentCall) return;
      const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
      if (!call) return;
      clearTimeout(callState.ringing.timeout);
      const customerSid = callState.ringing.customerSocketId;
      run("UPDATE calls SET status = 'active', answered_at = ?, handled_by = ? WHERE id = ?",
        [now(), u.uid, callId]);
      // Update conversation status
      run("UPDATE conversations SET status = 'IN_CALL', updated_at = ? WHERE id = ?", [now(), call.conversation_id]);
      callState.currentCall = { callId, customerSocketId: customerSid, agentSocketId: socket.id, startedAt: now() };
      callState.ringing = null;
      // Tell customer the call is accepted (WebRTC signaling will start)
      io.to(customerSid).emit('call:accepted', { callId, agentSocketId: socket.id });
      socket.emit('call:accepted', { callId, customerSocketId: customerSid });
      // Kick next waiting caller into ringing
      promoteQueueToRinging();
      broadcastDashboard();
    });

    socket.on('call:reject', ({ callId }) => {
      if (!callState.ringing || callState.ringing.callId !== callId) return;
      clearTimeout(callState.ringing.timeout);
      const customerSid = callState.ringing.customerSocketId;
      run("UPDATE calls SET status = 'missed', ended_at = ?, end_reason = 'rejected' WHERE id = ?", [now(), callId]);
      io.to(customerSid).emit('call:rejected', { callId });
      callState.ringing = null;
      promoteQueueToRinging();
      broadcastDashboard();
    });

    socket.on('call:hangup', ({ callId }) => {
      endCall(callId, 'agent_hangup');
    });

    // WebRTC signaling (authenticated agent) — only forward between connected call peers
    socket.on('webrtc:signal', ({ to, signal }) => {
      if (callState.currentCall && callState.currentCall.agentSocketId === socket.id && to === callState.currentCall.customerSocketId) {
        io.to(to).emit('webrtc:signal', { from: socket.id, signal });
      }
    });

    socket.on('disconnect', () => {
      agents.delete(socket.id);
      io.to('agents').emit('agents:presence', [...agents.values()]);
      // If agent was on a call, end it
      if (callState.currentCall && callState.currentCall.agentSocketId === socket.id) {
        endCall(callState.currentCall.callId, 'agent_disconnected');
      }
      if (callState.ringing) {
        // Route ringing to other agents? Simplest: miss the call and try queue.
        clearTimeout(callState.ringing.timeout);
        const customerSid = callState.ringing.customerSocketId;
        const callId = callState.ringing.callId;
        run("UPDATE calls SET status = 'missed', ended_at = ?, end_reason = 'no_agent' WHERE id = ?", [now(), callId]);
        io.to(customerSid).emit('call:rejected', { callId, reason: 'No agent available' });
        callState.ringing = null;
        promoteQueueToRinging();
      }
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
      return ack?.({ ok: true, conversationId });
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
    socket.on('call:request', (payload) => {
      const parsed = z.object({ conversationId: z.string().min(1).max(100) }).safeParse(payload);
      if (!parsed.success) return socket.emit('call:error', { message: 'Invalid call request.' });
      const { conversationId } = parsed.data;
      const cdata = customers.get(socket.id);
      const ownedConversation = customerOwnsConversation(verifiedCustomer.customerId, conversationId);
      if (!cdata || cdata.conversationId !== conversationId || !ownedConversation) {
        return socket.emit('call:error', { message: 'Not authorized for this conversation.' });
      }
      // Prevent duplicate active/waiting calls for this customer
      const existing = get(
        "SELECT * FROM calls WHERE customer_id = ? AND status IN ('ringing','in_queue','active') LIMIT 1",
        [cdata.customerId]
      );
      if (existing) {
        socket.emit('call:error', { message: 'You already have a pending or active call.' });
        return;
      }
      const callId = 'ca_' + nanoid(12);
      const pos = callState.queue.length + (callState.currentCall || callState.ringing ? 1 : 0);
      run('INSERT INTO calls (id,customer_id,conversation_id,status,queue_position,started_at) VALUES (?,?,?,?,?,?)',
        [callId, cdata.customerId, conversationId, 'in_queue', pos, now()]);
      run("UPDATE conversations SET status = 'WAITING_CALL', updated_at = ? WHERE id = ?", [now(), conversationId]);

      const queueItem = {
        callId,
        customerId: cdata.customerId,
        conversationId,
        customerName: cdata.name || 'Customer',
        customerSocketId: socket.id,
        enqueuedAt: now(),
      };

      if (!callState.currentCall && !callState.ringing) {
        // Ring immediately
        startRinging(queueItem);
      } else {
        callState.queue.push(queueItem);
        socket.emit('call:queued', { callId, position: callState.queue.length });
        io.to('agents').emit('call:queued', {
          callId,
          customerName: cdata.name,
          position: callState.queue.length,
          customer: get('SELECT name, requirement FROM customers WHERE id = ?', [cdata.customerId]),
          conversationId,
        });
      }
      broadcastDashboard();
    });

    socket.on('call:hangup', ({ callId }) => {
      // Customer ends call
      endCall(callId, 'customer_hangup');
    });

    socket.on('call:cancel', () => {
      // Cancel queued call
      const entry = callState.queue.find(q => q.customerSocketId === socket.id);
      if (entry) {
        callState.queue = callState.queue.filter(q => q.callId !== entry.callId);
        run("UPDATE calls SET status = 'cancelled', ended_at = ?, end_reason = 'customer_cancel', duration = 0 WHERE id = ?",
          [now(), entry.callId]);
        socket.emit('call:cancelled');
        updateQueuePositions();
        broadcastDashboard();
        return;
      }
      if (callState.ringing && callState.ringing.customerSocketId === socket.id) {
        clearTimeout(callState.ringing.timeout);
        run("UPDATE calls SET status = 'cancelled', ended_at = ?, end_reason = 'customer_cancel' WHERE id = ?",
          [now(), callState.ringing.callId]);
        callState.ringing = null;
        socket.emit('call:cancelled');
        promoteQueueToRinging();
        broadcastDashboard();
      }
    });

    // WebRTC signaling (customer)
    socket.on('webrtc:signal', ({ to, signal }) => {
      if (callState.currentCall && callState.currentCall.customerSocketId === socket.id && to === callState.currentCall.agentSocketId) {
        io.to(to).emit('webrtc:signal', { from: socket.id, signal });
      }
    });

    socket.on('disconnect', () => {
      customers.delete(socket.id);
      // If was in a call, end it
      if (callState.currentCall && callState.currentCall.customerSocketId === socket.id) {
        endCall(callState.currentCall.callId, 'customer_disconnected');
      }
      if (callState.ringing && callState.ringing.customerSocketId === socket.id) {
        clearTimeout(callState.ringing.timeout);
        run("UPDATE calls SET status = 'missed', ended_at = ?, end_reason = 'customer_disconnected' WHERE id = ?",
          [now(), callState.ringing.callId]);
        callState.ringing = null;
        promoteQueueToRinging();
      }
      // Remove from queue if queued
      const qidx = callState.queue.findIndex(q => q.customerSocketId === socket.id);
      if (qidx >= 0) {
        const entry = callState.queue[qidx];
        run("UPDATE calls SET status = 'cancelled', ended_at = ?, end_reason = 'customer_disconnected' WHERE id = ?",
          [now(), entry.callId]);
        callState.queue.splice(qidx, 1);
        updateQueuePositions();
      }
      broadcastDashboard();
    });
  }
});

function startRinging(queueItem) {
  run("UPDATE calls SET status = 'ringing', queue_position = 0 WHERE id = ?", [queueItem.callId]);
  const timeout = setTimeout(() => {
    // Agent didn't answer in time — miss and try next
    if (!callState.ringing) return;
    run("UPDATE calls SET status = 'missed', ended_at = ?, end_reason = 'timeout' WHERE id = ?",
      [now(), queueItem.callId]);
    io.to(queueItem.customerSocketId).emit('call:rejected', { callId: queueItem.callId, reason: 'No answer' });
    callState.ringing = null;
    promoteQueueToRinging();
    broadcastDashboard();
  }, 30_000); // 30s ring timeout
  callState.ringing = { ...queueItem, timeout };
  const customer = get('SELECT name, requirement FROM customers WHERE id = ?', [queueItem.customerId]);
  const msgs = all(
    'SELECT id, sender_type as senderType, message, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
    [queueItem.conversationId]
  );
  io.to('agents').emit('call:incoming', {
    callId: queueItem.callId,
    customer,
    conversationId: queueItem.conversationId,
    messages: msgs,
  });
  io.to(queueItem.customerSocketId).emit('call:ringing', { callId: queueItem.callId });
}

function promoteQueueToRinging() {
  if (callState.currentCall || callState.ringing) return;
  const next = callState.queue.shift();
  if (!next) return;
  updateQueuePositions();
  startRinging(next);
}

function updateQueuePositions() {
  callState.queue.forEach((q, i) => {
    run('UPDATE calls SET queue_position = ? WHERE id = ?', [i + 1, q.callId]);
    io.to(q.customerSocketId).emit('call:queued', { callId: q.callId, position: i + 1 });
  });
  io.to('agents').emit('call:queue_update', callState.queue.map((q, i) => ({
    callId: q.callId, customerName: q.customerName, position: i + 1,
  })));
}

function endCall(callId, reason) {
  const call = get('SELECT * FROM calls WHERE id = ?', [callId]);
  if (!call) return;
  if (call.status === 'ended' || call.status === 'rejected' || call.status === 'missed' || call.status === 'cancelled') return;
  const endedAt = now();
  const duration = call.answered_at ? Math.max(0, Math.round((endedAt - call.answered_at) / 1000)) : 0;
  run("UPDATE calls SET status = 'ended', ended_at = ?, duration = ?, end_reason = ? WHERE id = ?",
    [endedAt, duration, reason || 'ended', callId]);
  // Restore conversation: if it was IN_CALL, go back to HUMAN_ACTIVE if an agent was assigned, else AI_ACTIVE/HUMAN_REQUIRED as before
  const conv = get('SELECT * FROM conversations WHERE id = ?', [call.conversation_id]);
  if (conv && conv.status === 'IN_CALL') {
    const newStatus = conv.assigned_agent_id ? 'HUMAN_ACTIVE' : (conv.status === 'HUMAN_REQUIRED' ? 'HUMAN_REQUIRED' : 'AI_ACTIVE');
    run('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?', [newStatus, endedAt, call.conversation_id]);
  }
  if (callState.currentCall && callState.currentCall.callId === callId) {
    io.to(callState.currentCall.customerSocketId).emit('call:ended', { callId, duration, reason });
    io.to(callState.currentCall.agentSocketId).emit('call:ended', { callId, duration, reason });
    callState.currentCall = null;
    promoteQueueToRinging();
  } else if (callState.ringing && callState.ringing.callId === callId) {
    clearTimeout(callState.ringing.timeout);
    io.to(callState.ringing.customerSocketId).emit('call:ended', { callId, duration: 0, reason });
    callState.ringing = null;
    promoteQueueToRinging();
  } else {
    // Was in queue
    callState.queue = callState.queue.filter(q => q.callId !== callId);
    updateQueuePositions();
  }
  broadcastDashboard();
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
    await initDb();
    await importKnowledgeFile();
    server.listen(PORT, () => {
      console.log(`[server] Electricalskart Help Desk listening on port ${PORT} (${NODE_ENV})`);
    });
  } catch (error) {
    console.error(`[startup] Configuration error: ${error.message}`);
    process.exitCode = 1;
  }
})();
