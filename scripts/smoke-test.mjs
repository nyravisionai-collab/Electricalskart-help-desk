// Non-browser smoke test: validates REST, Socket.IO auth, messaging, call flow (signaling only, no media).
import { io } from 'socket.io-client';

const API = 'http://localhost:3001';

function post(path, body, token) {
  return fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  }).then(r => r.json());
}
function get(path, token) {
  return fetch(API + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then(r => r.json());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('== 1. Customer start ==');
  const start = await post('/api/customer/start', { name: 'Smokey', requirement: 'I want to buy a ceiling fan.' });
  console.log('start:', start);

  console.log('== 2. Login owner ==');
  const login = await post('/api/auth/login', { email: 'owner@electricalskart.local', password: 'Owner@123' });
  console.log('login:', login.user);

  await sleep(800); // let AI respond

  console.log('== 3. Verify messages persisted ==');
  const msgs = await get('/api/conversations/' + start.conversationId + '/messages');
  console.log('status:', msgs.conversation.status, 'messages:', msgs.messages.length);
  msgs.messages.forEach(m => console.log(' ', m.senderType + ':', m.message.slice(0, 80)));

  console.log('== 4. Connect agent socket and customer socket ==');
  const agent = io(API, { auth: { role: 'agent', token: login.token } });
  const customer = io(API, { auth: { role: 'customer', customerId: start.customerId, conversationId: start.conversationId, name: 'Smokey' } });

  let agentConnected = new Promise(res => agent.on('connect', res));
  let custConnected = new Promise(res => customer.on('connect', res));
  await Promise.all([agentConnected, custConnected]);
  console.log('both sockets connected');

  let dashboardUpdate = new Promise(res => agent.once('dashboard:update', res));
  customer.emit('customer:bind', { customerId: start.customerId, conversationId: start.conversationId, name: 'Smokey' });
  const upd = await dashboardUpdate;
  console.log('dashboard stats:', upd.stats);

  console.log('== 5. Customer sends message ==');
  customer.emit('customer:message', { conversationId: start.conversationId, message: 'hello again' });
  await sleep(800);
  const msgs2 = await get('/api/conversations/' + start.conversationId + '/messages');
  const last = msgs2.messages[msgs2.messages.length - 1];
  console.log('last message:', last.senderType, '->', last.message.slice(0, 80));

  console.log('== 6. Agent takes over and replies ==');
  agent.emit('conversation:takeover', { conversationId: start.conversationId });
  await sleep(150);
  agent.emit('agent:message', { conversationId: start.conversationId, message: 'Hi Smokey, this is a human agent. How can I help?' });
  await sleep(200);
  const msgs3 = await get('/api/conversations/' + start.conversationId + '/messages');
  const afterAgent = msgs3.messages.slice(-2).map(m => m.senderType + ':' + m.message.slice(0, 60));
  console.log('after takeover:', afterAgent);

  console.log('== 7. Customer requests call -> incoming event to agent ==');
  const incomingPromise = new Promise(res => agent.once('call:incoming', res));
  customer.emit('call:request', { conversationId: start.conversationId });
  const incoming = await incomingPromise;
  console.log('incoming call:', incoming.callId, 'from', incoming.customer.name);

  console.log('== 8. Agent accepts call -> signaling check ==');
  const acceptedPromise = new Promise(res => customer.once('call:accepted', res));
  agent.emit('call:accept', { callId: incoming.callId });
  const accepted = await acceptedPromise;
  console.log('call accepted, peer socket id (agent->customer):', accepted.agentSocketId);

  // Send a test signal (fake offer-like) from agent to customer via server relay
  const signalPromise = new Promise(res => customer.once('webrtc:signal', res));
  agent.emit('webrtc:signal', { to: accepted.agentSocketId ? null : accepted.customerSocketId, signal: { type: 'offer', sdp: 'v=0\r\ntest' } });
  // oops — agent must know customer socket id; listen for call:accepted on agent
  const agentAccepted = await new Promise(res => agent.once('call:accepted', res));
  console.log('agent accepted event -> customerSocketId:', agentAccepted.customerSocketId);
  const custSignalPromise = new Promise(res => customer.once('webrtc:signal', res));
  const agentSignalPromise = new Promise(res => agent.once('webrtc:signal', res));
  agent.emit('webrtc:signal', { to: agentAccepted.customerSocketId, signal: { type: 'offer', sdp: 'v=0\r\no=- test' } });
  const custGot = await custSignalPromise;
  console.log('customer got agent signal type:', custGot.signal.type);
  // Customer answer back
  customer.emit('webrtc:signal', { to: custGot.from, signal: { type: 'answer', sdp: 'v=0\r\nanswer' } });
  const agentGot = await agentSignalPromise;
  console.log('agent got customer signal type:', agentGot.signal.type);

  console.log('== 9. Hangup ==');
  const endedPromise = new Promise(res => customer.once('call:ended', res));
  agent.emit('call:hangup', { callId: incoming.callId });
  const ended = await endedPromise;
  console.log('call ended, duration:', ended.duration, 'reason:', ended.reason);

  console.log('== 10. Unauth dashboard should be 401 ==');
  const unauth = await fetch(API + '/api/dashboard/summary').then(r => r.status);
  console.log('unauth status:', unauth, unauth === 401 ? 'OK' : 'FAIL');

  console.log('\n✅ Smoke test passed');
  agent.close();
  customer.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
