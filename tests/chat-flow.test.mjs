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
let agent;
let ownerToken;
const sockets = [];

before(async () => {
  server = await startTestServer();
  const login = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'owner@example.test', password: 'TestOwnerPassword!123' },
  });
  ownerToken = login.data.token;
  agent = connectSocket(server.baseUrl, { role: 'agent', token: ownerToken });
  sockets.push(agent);
  await onceEvent(agent, 'connect');
});

after(async () => {
  sockets.forEach(socket => socket.close());
  await server?.stop();
});

test('customer AI escalation, human takeover, reply, and agent-approved suggestion flow', async () => {
  const humanRequiredAlert = onceEvent(agent, 'alert:human_required', { timeout: 5_000 });
  const customer = await startCustomer(
    server.baseUrl,
    'Complete Chat Customer',
    'I need help with a product that is not in verified data.',
  );
  const customerSocket = connectSocket(server.baseUrl, { role: 'customer', token: customer.customerToken });
  sockets.push(customerSocket);
  await onceEvent(customerSocket, 'connect');
  await emitWithAck(customerSocket, 'customer:bind', { conversationId: customer.conversationId });

  const escalatedMessagesPromise = onceEvent(customerSocket, 'conversation:messages', {
    predicate: messages => Array.isArray(messages) && messages.some(message => message.senderType === 'AI'),
  });
  const alert = await humanRequiredAlert;
  assert.equal(alert.conversationId, customer.conversationId);
  const escalatedMessages = await escalatedMessagesPromise;
  assert.equal(escalatedMessages.some(message => /enough verified/i.test(message.message)), true);

  const humanActive = onceEvent(customerSocket, 'conversation:status', {
    predicate: event => event.status === 'HUMAN_ACTIVE',
  });
  agent.emit('conversation:takeover', { conversationId: customer.conversationId });
  await humanActive;

  const replyText = 'A human support representative is now helping you.';
  const replyDelivered = onceEvent(customerSocket, 'conversation:messages', {
    predicate: messages => Array.isArray(messages) && messages.some(message => message.senderType === 'AGENT' && message.message === replyText),
  });
  agent.emit('agent:message', { conversationId: customer.conversationId, message: replyText });
  await replyDelivered;

  const beforeSuggestion = await apiRequest(server.baseUrl, `/api/conversations/${customer.conversationId}/messages`, {
    customerToken: customer.customerToken,
  });
  const suggestion = await emitWithAck(agent, 'agent:suggest', { conversationId: customer.conversationId });
  assert.ok(suggestion.suggestion);
  const afterSuggestion = await apiRequest(server.baseUrl, `/api/conversations/${customer.conversationId}/messages`, {
    customerToken: customer.customerToken,
  });
  assert.equal(afterSuggestion.data.messages.length, beforeSuggestion.data.messages.length);
  assert.equal(afterSuggestion.data.messages.filter(message => message.senderType === 'AGENT').length, 1);
  assert.equal(afterSuggestion.data.conversation.status, 'HUMAN_ACTIVE');
});
