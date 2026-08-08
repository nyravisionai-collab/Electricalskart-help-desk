import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { apiRequest, startCustomer, startTestServer } from './helpers/server.mjs';

let server;
let ownerToken;

async function waitForConversation(customer, predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await apiRequest(server.baseUrl, `/api/conversations/${customer.conversationId}/messages`, {
      customerToken: customer.customerToken,
    });
    if (response.status === 200 && predicate(response.data)) return response.data;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Conversation did not reach expected grounded AI state');
}

before(async () => {
  server = await startTestServer();
  const login = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'owner@example.test', password: 'TestOwnerPassword!123' },
  });
  ownerToken = login.data.token;
});

after(async () => {
  await server?.stop();
});

test('unknown business facts are not invented and escalate to a human', async () => {
  const customer = await startCustomer(server.baseUrl, 'Unknown Facts Customer', 'What are your store hours?');
  const conversation = await waitForConversation(
    customer,
    data => data.conversation.status === 'HUMAN_REQUIRED',
  );
  const aiText = conversation.messages.filter(message => message.senderType === 'AI').map(message => message.message).join('\n');
  assert.match(aiText, /do not have enough verified Electricalskart information/i);
  assert.doesNotMatch(aiText, /Monday|Saturday|Sunday|10am|8pm/i);
});

test('Owner-verified application knowledge is used verbatim for factual answers', async () => {
  const created = await apiRequest(server.baseUrl, '/api/knowledge', {
    token: ownerToken,
    body: {
      topic: 'store_hours',
      title: 'Verified store hours',
      content: 'The support desk is open Monday through Friday from 9:30 AM to 6:00 PM IST.',
      keywords: ['store', 'hours', 'open', 'timing'],
      source: 'Owner verification for automated test',
      active: true,
    },
  });
  assert.equal(created.status, 201);

  const customer = await startCustomer(server.baseUrl, 'Grounded Facts Customer', 'What are your store hours?');
  const conversation = await waitForConversation(
    customer,
    data => data.messages.some(message => message.senderType === 'AI'),
  );
  assert.equal(conversation.conversation.status, 'AI_ACTIVE');
  const aiText = conversation.messages.filter(message => message.senderType === 'AI').at(-1).message;
  assert.match(aiText, /The support desk is open Monday through Friday from 9:30 AM to 6:00 PM IST\./);
});

test('Agent cannot modify verified business knowledge', async () => {
  const createAgent = await apiRequest(server.baseUrl, '/api/agents', {
    token: ownerToken,
    body: { name: 'Knowledge Agent', email: 'knowledge-agent@example.test', password: 'KnowledgeAgent!123' },
  });
  assert.equal(createAgent.status, 200);
  const login = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'knowledge-agent@example.test', password: 'KnowledgeAgent!123' },
  });
  const attempt = await apiRequest(server.baseUrl, '/api/knowledge', {
    token: login.data.token,
    body: {
      topic: 'unverified',
      title: 'Unverified claim',
      content: 'This must not be stored.',
      keywords: ['claim'],
      source: 'Untrusted agent',
    },
  });
  assert.equal(attempt.status, 403);
});
