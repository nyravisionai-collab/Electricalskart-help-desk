import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  apiRequest,
  connectSocket,
  emitWithAck,
  onceEvent,
  startCustomer,
  startTestServer,
} from './helpers/server.mjs';

let currentServer;
const sockets = [];

after(async () => {
  sockets.forEach(socket => socket.close());
  await currentServer?.stop();
});

async function loginOwner(server) {
  const response = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'owner@example.test', password: 'TestOwnerPassword!123' },
  });
  assert.equal(response.status, 200);
  return response.data.token;
}

async function connectCustomer(server, customer) {
  const socket = connectSocket(server.baseUrl, { role: 'customer', token: customer.customerToken });
  sockets.push(socket);
  await onceEvent(socket, 'connect');
  await emitWithAck(socket, 'customer:bind', { conversationId: customer.conversationId });
  return socket;
}

test('startup reconciliation fails stale active calls and safely restores the persistent waiting queue', async () => {
  const environment = { CALL_RING_TIMEOUT_MS: '5000', CALL_QUEUE_TTL_MS: '60000' };
  currentServer = await startTestServer({ env: environment });
  const directory = currentServer.directory;
  const dbFile = currentServer.dbFile;
  const ownerToken = await loginOwner(currentServer);
  const agent = connectSocket(currentServer.baseUrl, { role: 'agent', token: ownerToken });
  sockets.push(agent);
  await onceEvent(agent, 'connect');

  const first = await startCustomer(currentServer.baseUrl, 'Restart Active Customer', 'hello');
  const firstSocket = await connectCustomer(currentServer, first);
  const firstIncomingPromise = onceEvent(agent, 'call:incoming', {
    predicate: event => event.conversationId === first.conversationId,
  });
  const firstRequest = await emitWithAck(firstSocket, 'call:request', { conversationId: first.conversationId });
  const firstIncoming = await firstIncomingPromise;
  assert.equal(firstIncoming.callId, firstRequest.callId);
  await emitWithAck(agent, 'call:accept', { callId: firstRequest.callId });

  const second = await startCustomer(currentServer.baseUrl, 'Restart Waiting Customer', 'hello');
  const secondSocket = await connectCustomer(currentServer, second);
  const secondRequest = await emitWithAck(secondSocket, 'call:request', { conversationId: second.conversationId });
  assert.equal(secondRequest.position, 1);
  const queuedBeforeRestart = await apiRequest(currentServer.baseUrl, `/api/calls/${secondRequest.callId}`, { token: ownerToken });
  assert.equal(queuedBeforeRestart.data.call.status, 'WAITING');

  // Simulate an ungraceful process crash: no in-memory cleanup can run.
  await currentServer.stop('SIGKILL');
  agent.close();
  firstSocket.close();
  secondSocket.close();

  currentServer = await startTestServer({ directory, dbFile, env: environment });
  const ownerTokenAfterRestart = await loginOwner(currentServer);
  const recoveredAgent = connectSocket(currentServer.baseUrl, { role: 'agent', token: ownerTokenAfterRestart });
  sockets.push(recoveredAgent);
  await onceEvent(recoveredAgent, 'connect');

  const staleActive = await apiRequest(currentServer.baseUrl, `/api/calls/${firstRequest.callId}`, { token: ownerTokenAfterRestart });
  assert.equal(staleActive.data.call.status, 'FAILED');
  assert.equal(staleActive.data.call.end_reason, 'server_restart');
  const firstConversation = await apiRequest(currentServer.baseUrl, `/api/conversations/${first.conversationId}/messages`, {
    customerToken: first.customerToken,
  });
  assert.equal(firstConversation.data.conversation.status, 'AI_ACTIVE');

  const waitingAfterRestart = await apiRequest(currentServer.baseUrl, `/api/calls/${secondRequest.callId}`, { token: ownerTokenAfterRestart });
  assert.equal(waitingAfterRestart.data.call.status, 'WAITING');
  assert.equal(waitingAfterRestart.data.call.queue_position, 1);

  const promoted = onceEvent(recoveredAgent, 'call:incoming', {
    predicate: event => event.callId === secondRequest.callId,
  });
  const recoveredCustomer = connectSocket(currentServer.baseUrl, { role: 'customer', token: second.customerToken });
  sockets.push(recoveredCustomer);
  await onceEvent(recoveredCustomer, 'connect');
  await emitWithAck(recoveredCustomer, 'customer:bind', { conversationId: second.conversationId });
  await promoted;

  const ringingAfterReconnect = await apiRequest(currentServer.baseUrl, `/api/calls/${secondRequest.callId}`, { token: ownerTokenAfterRestart });
  assert.equal(ringingAfterReconnect.data.call.status, 'RINGING');
  await emitWithAck(recoveredAgent, 'call:reject', { callId: secondRequest.callId });

  const history = await apiRequest(currentServer.baseUrl, '/api/calls/history', { token: ownerTokenAfterRestart });
  assert.equal(history.data.calls.some(call => call.id === firstRequest.callId && call.status === 'FAILED'), true);
  assert.equal(history.data.calls.some(call => call.id === secondRequest.callId && call.status === 'REJECTED'), true);
});
