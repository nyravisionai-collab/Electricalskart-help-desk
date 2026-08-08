import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  apiRequest,
  connectSocket,
  emitWithAck,
  onceEvent,
  startCustomer,
  startTestServer,
} from './helpers/server.mjs';

let server;
let ownerToken;
let ownerSocket;
const sockets = [];

async function openCustomer(name, requirement = 'hello') {
  const customer = await startCustomer(server.baseUrl, name, requirement);
  const socket = connectSocket(server.baseUrl, { role: 'customer', token: customer.customerToken });
  sockets.push(socket);
  await onceEvent(socket, 'connect');
  const bind = await emitWithAck(socket, 'customer:bind', { conversationId: customer.conversationId });
  assert.equal(bind.ok, true);
  return { customer, socket };
}

async function requestRingingCall(entry) {
  const incoming = onceEvent(ownerSocket, 'call:incoming', {
    predicate: event => event.conversationId === entry.customer.conversationId,
  });
  const requested = await emitWithAck(entry.socket, 'call:request', {
    conversationId: entry.customer.conversationId,
  });
  assert.equal(requested.ok, true);
  const event = await incoming;
  assert.equal(event.callId, requested.callId);
  return event;
}

async function conversation(entry) {
  const response = await apiRequest(server.baseUrl, `/api/conversations/${entry.customer.conversationId}/messages`, {
    customerToken: entry.customer.customerToken,
  });
  assert.equal(response.status, 200);
  return response.data.conversation;
}

async function callRecord(callId) {
  const response = await apiRequest(server.baseUrl, `/api/calls/${callId}`, { token: ownerToken });
  assert.equal(response.status, 200);
  return response.data.call;
}

before(async () => {
  server = await startTestServer({ env: { CALL_RING_TIMEOUT_MS: '700', CALL_QUEUE_TTL_MS: '30000' } });
  const login = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'owner@example.test', password: 'TestOwnerPassword!123' },
  });
  ownerToken = login.data.token;
  ownerSocket = connectSocket(server.baseUrl, { role: 'agent', token: ownerToken });
  sockets.push(ownerSocket);
  await onceEvent(ownerSocket, 'connect');
});

after(async () => {
  sockets.forEach(socket => socket.close());
  await server?.stop();
});

test('reject restores the exact previous conversation state', async () => {
  const entry = await openCustomer('Reject Customer');
  const incoming = await requestRingingCall(entry);
  const rejectedEvent = onceEvent(entry.socket, 'call:rejected', {
    predicate: event => event.callId === incoming.callId,
  });
  const rejected = await emitWithAck(ownerSocket, 'call:reject', { callId: incoming.callId });
  assert.equal(rejected.ok, true);
  await rejectedEvent;
  assert.equal((await callRecord(incoming.callId)).status, 'REJECTED');
  assert.equal((await conversation(entry)).status, 'AI_ACTIVE');
});

test('customer cancellation restores conversation and records CANCELLED', async () => {
  const entry = await openCustomer('Cancel Customer');
  const incoming = await requestRingingCall(entry);
  const cancelledEvent = onceEvent(entry.socket, 'call:cancelled', {
    predicate: event => event.callId === incoming.callId,
  });
  const cancelled = await emitWithAck(entry.socket, 'call:cancel', {});
  assert.equal(cancelled.ok, true);
  await cancelledEvent;
  assert.equal((await callRecord(incoming.callId)).status, 'CANCELLED');
  assert.equal((await conversation(entry)).status, 'AI_ACTIVE');
});

test('ring timeout records MISSED and does not strand WAITING_CALL', async () => {
  const entry = await openCustomer('Timeout Customer');
  const incoming = await requestRingingCall(entry);
  const timeoutEvent = await onceEvent(entry.socket, 'call:rejected', {
    predicate: event => event.callId === incoming.callId && event.reason === 'ring_timeout',
    timeout: 3_000,
  });
  assert.equal(timeoutEvent.status, 'MISSED');
  assert.equal((await callRecord(incoming.callId)).status, 'MISSED');
  assert.equal((await conversation(entry)).status, 'AI_ACTIVE');
});

test('accepted call ends cleanly and duplicate call is prevented', async () => {
  const entry = await openCustomer('Active Customer');
  const incoming = await requestRingingCall(entry);

  const duplicate = await emitWithAck(entry.socket, 'call:request', {
    conversationId: entry.customer.conversationId,
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'DUPLICATE_CALL');

  const customerAccepted = onceEvent(entry.socket, 'call:accepted', {
    predicate: event => event.callId === incoming.callId,
  });
  const agentAccepted = onceEvent(ownerSocket, 'call:accepted', {
    predicate: event => event.callId === incoming.callId,
  });
  const accepted = await emitWithAck(ownerSocket, 'call:accept', { callId: incoming.callId });
  assert.equal(accepted.ok, true);
  await Promise.all([customerAccepted, agentAccepted]);
  assert.equal((await callRecord(incoming.callId)).status, 'ACTIVE');
  assert.equal((await conversation(entry)).status, 'IN_CALL');

  const endedEvent = onceEvent(entry.socket, 'call:ended', {
    predicate: event => event.callId === incoming.callId,
  });
  const ended = await emitWithAck(ownerSocket, 'call:hangup', { callId: incoming.callId });
  assert.equal(ended.ok, true);
  await endedEvent;
  assert.equal((await callRecord(incoming.callId)).status, 'ENDED');
  assert.equal((await conversation(entry)).status, 'AI_ACTIVE');
});

test('second customer remains in persistent queue until current call ends', async () => {
  const first = await openCustomer('Queue Customer One');
  const firstIncoming = await requestRingingCall(first);
  const firstAccepted = onceEvent(first.socket, 'call:accepted', {
    predicate: event => event.callId === firstIncoming.callId,
  });
  await emitWithAck(ownerSocket, 'call:accept', { callId: firstIncoming.callId });
  await firstAccepted;

  const second = await openCustomer('Queue Customer Two');
  const queued = await emitWithAck(second.socket, 'call:request', {
    conversationId: second.customer.conversationId,
  });
  assert.equal(queued.ok, true);
  assert.equal(queued.position, 1);
  assert.equal((await callRecord(queued.callId)).status, 'WAITING');

  const promoted = onceEvent(ownerSocket, 'call:incoming', {
    predicate: event => event.callId === queued.callId,
  });
  await emitWithAck(ownerSocket, 'call:hangup', { callId: firstIncoming.callId });
  await promoted;
  assert.equal((await callRecord(queued.callId)).status, 'RINGING');
  await emitWithAck(ownerSocket, 'call:reject', { callId: queued.callId });
});

test('HUMAN_REQUIRED is restored after a rejected call', async () => {
  const entry = await openCustomer('Human Required Caller', 'I need an unknown exact product price');
  const deadline = Date.now() + 4_000;
  while ((await conversation(entry)).status !== 'HUMAN_REQUIRED' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await conversation(entry)).status, 'HUMAN_REQUIRED');
  const incoming = await requestRingingCall(entry);
  await emitWithAck(ownerSocket, 'call:reject', { callId: incoming.callId });
  assert.equal((await conversation(entry)).status, 'HUMAN_REQUIRED');
});

test('only one agent claims a call and unrelated agent disconnect does not cancel ringing', async () => {
  const createAgent = await apiRequest(server.baseUrl, '/api/agents', {
    token: ownerToken,
    body: { name: 'Second Agent', email: 'second-agent@example.test', password: 'SecondAgentPass!123' },
  });
  assert.equal(createAgent.status, 200);
  const agentLogin = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'second-agent@example.test', password: 'SecondAgentPass!123' },
  });
  const secondAgent = connectSocket(server.baseUrl, { role: 'agent', token: agentLogin.data.token });
  sockets.push(secondAgent);
  await onceEvent(secondAgent, 'connect');

  const entry = await openCustomer('Multi Agent Customer');
  const secondIncoming = onceEvent(secondAgent, 'call:incoming', {
    predicate: event => event.conversationId === entry.customer.conversationId,
  });
  const incoming = await requestRingingCall(entry);
  await secondIncoming;

  secondAgent.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await callRecord(incoming.callId)).status, 'RINGING');

  const replacementAgent = connectSocket(server.baseUrl, { role: 'agent', token: agentLogin.data.token });
  sockets.push(replacementAgent);
  await onceEvent(replacementAgent, 'connect');
  const ownerTaken = onceEvent(ownerSocket, 'call:taken', { predicate: event => event.callId === incoming.callId });
  const otherTaken = onceEvent(replacementAgent, 'call:taken', { predicate: event => event.callId === incoming.callId });
  const accepted = await emitWithAck(ownerSocket, 'call:accept', { callId: incoming.callId });
  assert.equal(accepted.ok, true);
  await Promise.all([ownerTaken, otherTaken]);

  const secondAcceptance = await emitWithAck(replacementAgent, 'call:accept', { callId: incoming.callId });
  assert.equal(secondAcceptance.ok, false);
  assert.equal(secondAcceptance.error, 'CALL_NOT_RINGING');
  const active = await callRecord(incoming.callId);
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.handled_by, ownerLoginUserId());
  await emitWithAck(ownerSocket, 'call:hangup', { callId: incoming.callId });
});

function ownerLoginUserId() {
  const tokenPayload = JSON.parse(Buffer.from(ownerToken.split('.')[1], 'base64url').toString('utf8'));
  return tokenPayload.uid;
}
