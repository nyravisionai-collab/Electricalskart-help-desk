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
const sockets = [];

before(async () => {
  server = await startTestServer({ env: { AI_RESPONSE_DELAY_MS: '700' } });
});

after(async () => {
  sockets.forEach(socket => socket.close());
  await server?.stop();
});

test('pending AI response is discarded when human takeover changes the conversation revision', async () => {
  const login = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'owner@example.test', password: 'TestOwnerPassword!123' },
  });
  const customer = await startCustomer(
    server.baseUrl,
    'AI Race Customer',
    'Give me an unverified product fact',
  );

  const agentSocket = connectSocket(server.baseUrl, { role: 'agent', token: login.data.token });
  const customerSocket = connectSocket(server.baseUrl, { role: 'customer', token: customer.customerToken });
  sockets.push(agentSocket, customerSocket);
  await Promise.all([onceEvent(agentSocket, 'connect'), onceEvent(customerSocket, 'connect')]);
  await emitWithAck(customerSocket, 'customer:bind', { conversationId: customer.conversationId });

  // This proves generation passed its initial revision check and is pending.
  await onceEvent(customerSocket, 'ai:typing', { predicate: value => value === true, timeout: 3_000 });
  const humanActive = onceEvent(customerSocket, 'conversation:status', {
    predicate: value => value.status === 'HUMAN_ACTIVE',
  });
  agentSocket.emit('conversation:takeover', { conversationId: customer.conversationId });
  await humanActive;

  await new Promise(resolve => setTimeout(resolve, 1_000));
  const history = await apiRequest(server.baseUrl, `/api/conversations/${customer.conversationId}/messages`, {
    customerToken: customer.customerToken,
  });
  assert.equal(history.status, 200);
  assert.equal(history.data.conversation.status, 'HUMAN_ACTIVE');
  assert.equal(history.data.conversation.mode, 'human');
  assert.equal(history.data.messages.some(message => message.senderType === 'AI'), false);
  assert.equal(
    history.data.messages.some(message => message.senderType === 'SYSTEM' && /joined the chat/i.test(message.message)),
    true,
  );
});
