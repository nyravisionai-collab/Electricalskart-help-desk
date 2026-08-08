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
let customerA;
let customerB;
const sockets = [];

before(async () => {
  server = await startTestServer();
  customerA = await startCustomer(server.baseUrl, 'Customer A', 'A private requirement');
  customerB = await startCustomer(server.baseUrl, 'Customer B', 'B private requirement');
});

after(async () => {
  sockets.forEach(socket => socket.close());
  await server?.stop();
});

test('Customer A cannot read Customer B conversation over REST', async () => {
  const own = await apiRequest(server.baseUrl, `/api/conversations/${customerA.conversationId}/messages`, {
    customerToken: customerA.customerToken,
  });
  assert.equal(own.status, 200);

  const other = await apiRequest(server.baseUrl, `/api/conversations/${customerB.conversationId}/messages`, {
    customerToken: customerA.customerToken,
  });
  assert.equal(other.status, 403);
  assert.match(other.data.error, /not authorized/i);

  const anonymous = await apiRequest(server.baseUrl, `/api/conversations/${customerB.conversationId}/messages`);
  assert.equal(anonymous.status, 401);
});

test('invalid anonymous customer socket is rejected', async () => {
  const socket = connectSocket(server.baseUrl, { role: 'customer', token: 'not-a-valid-session-token' });
  sockets.push(socket);
  const error = await onceEvent(socket, 'connect_error');
  assert.match(error.message, /invalid customer session/i);
});

test('Customer A cannot bind or subscribe to Customer B conversation', async () => {
  const socketA = connectSocket(server.baseUrl, { role: 'customer', token: customerA.customerToken });
  const socketB = connectSocket(server.baseUrl, { role: 'customer', token: customerB.customerToken });
  sockets.push(socketA, socketB);
  await Promise.all([onceEvent(socketA, 'connect'), onceEvent(socketB, 'connect')]);

  const ownBind = await emitWithAck(socketA, 'customer:bind', { conversationId: customerA.conversationId });
  assert.equal(ownBind.ok, true);

  const forbiddenBind = await emitWithAck(socketA, 'customer:bind', { conversationId: customerB.conversationId });
  assert.equal(forbiddenBind.ok, false);
  assert.equal(forbiddenBind.error.code, 'FORBIDDEN');

  const bBind = await emitWithAck(socketB, 'customer:bind', { conversationId: customerB.conversationId });
  assert.equal(bBind.ok, true);

  let leaked = false;
  const onMessages = messages => {
    if (Array.isArray(messages) && messages.some(message => message.message === 'B REALTIME SECRET')) leaked = true;
  };
  socketA.on('conversation:messages', onMessages);
  const bUpdate = onceEvent(socketB, 'conversation:messages', {
    predicate: messages => Array.isArray(messages) && messages.some(message => message.message === 'B REALTIME SECRET'),
  });
  const sent = await emitWithAck(socketB, 'customer:message', {
    conversationId: customerB.conversationId,
    message: 'B REALTIME SECRET',
  });
  assert.equal(sent.ok, true);
  await bUpdate;
  await new Promise(resolve => setTimeout(resolve, 150));
  socketA.off('conversation:messages', onMessages);
  assert.equal(leaked, false);
});

test('Customer A cannot send a message to Customer B conversation', async () => {
  const socketA = connectSocket(server.baseUrl, { role: 'customer', token: customerA.customerToken });
  sockets.push(socketA);
  await onceEvent(socketA, 'connect');
  await emitWithAck(socketA, 'customer:bind', { conversationId: customerA.conversationId });

  const result = await emitWithAck(socketA, 'customer:message', {
    conversationId: customerB.conversationId,
    message: 'UNAUTHORIZED CUSTOMER A INJECTION',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FORBIDDEN');

  const history = await apiRequest(server.baseUrl, `/api/conversations/${customerB.conversationId}/messages`, {
    customerToken: customerB.customerToken,
  });
  assert.equal(history.status, 200);
  assert.equal(history.data.messages.some(message => message.message === 'UNAUTHORIZED CUSTOMER A INJECTION'), false);
});
