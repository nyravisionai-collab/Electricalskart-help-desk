import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import {
  apiRequest,
  connectSocket,
  createTestDirectory,
  emitWithAck,
  onceEvent,
  startCustomer,
  startTestServer,
} from './helpers/server.mjs';

const TEST_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';
let server;
let ownerLogin;

before(async () => {
  server = await startTestServer();
  ownerLogin = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'owner@example.test', password: 'TestOwnerPassword!123' },
  });
});

after(async () => {
  await server?.stop();
});

test('Owner login succeeds and bootstrap credentials are not logged', () => {
  assert.equal(ownerLogin.status, 200);
  assert.equal(ownerLogin.data.user.role, 'owner');
  assert.ok(ownerLogin.data.token);
  assert.doesNotMatch(server.getLogs(), /TestOwnerPassword!123/);
  assert.doesNotMatch(server.getLogs(), new RegExp(TEST_SECRET));
});

test('invalid password is rejected', async () => {
  const result = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'owner@example.test', password: 'DefinitelyWrongPassword' },
  });
  assert.equal(result.status, 401);
  assert.equal(result.data.error, 'Invalid credentials');
});

test('invalid and expired JWTs are rejected', async () => {
  const invalid = await apiRequest(server.baseUrl, '/api/dashboard/summary', { token: 'not-a-jwt' });
  assert.equal(invalid.status, 401);

  const expiredToken = jwt.sign(
    {
      uid: ownerLogin.data.user.id,
      role: 'owner',
      name: 'Test Owner',
      email: 'owner@example.test',
      tokenType: 'staff',
    },
    TEST_SECRET,
    {
      algorithm: 'HS256',
      audience: 'electricalskart-staff',
      issuer: 'electricalskart-helpdesk',
      expiresIn: -1,
    },
  );
  const expired = await apiRequest(server.baseUrl, '/api/dashboard/summary', { token: expiredToken });
  assert.equal(expired.status, 401);
});

test('customer session token cannot access staff API', async () => {
  const customer = await startCustomer(server.baseUrl, 'Auth Test Customer');
  const result = await apiRequest(server.baseUrl, '/api/dashboard/summary', { token: customer.customerToken });
  assert.equal(result.status, 401);
});

test('Agent cannot access Owner-only API and token role claims do not override database role', async () => {
  const created = await apiRequest(server.baseUrl, '/api/agents', {
    token: ownerLogin.data.token,
    body: {
      name: 'Support Agent',
      email: 'agent@example.test',
      password: 'AgentPassword!123',
    },
  });
  assert.equal(created.status, 200);

  const login = await apiRequest(server.baseUrl, '/api/auth/login', {
    body: { email: 'agent@example.test', password: 'AgentPassword!123' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'agent');

  const forbidden = await apiRequest(server.baseUrl, '/api/agents', { token: login.data.token });
  assert.equal(forbidden.status, 403);

  const forgedRoleToken = jwt.sign(
    {
      uid: login.data.user.id,
      role: 'owner',
      name: 'Support Agent',
      email: 'agent@example.test',
      tokenType: 'staff',
    },
    TEST_SECRET,
    {
      algorithm: 'HS256',
      audience: 'electricalskart-staff',
      issuer: 'electricalskart-helpdesk',
      expiresIn: '5m',
    },
  );
  const forgedForbidden = await apiRequest(server.baseUrl, '/api/agents', { token: forgedRoleToken });
  assert.equal(forgedForbidden.status, 403);
});

test('malformed authenticated socket events are rejected without crashing the server', async () => {
  const socket = connectSocket(server.baseUrl, { role: 'agent', token: ownerLogin.data.token });
  await onceEvent(socket, 'connect');
  const takeover = await emitWithAck(socket, 'conversation:takeover', null);
  const message = await emitWithAck(socket, 'agent:message', { conversationId: 42, message: null });
  const suggestion = await emitWithAck(socket, 'agent:suggest', undefined);
  assert.equal(takeover.ok, false);
  assert.equal(message.ok, false);
  assert.equal(suggestion.ok, false);
  socket.close();

  const health = await apiRequest(server.baseUrl, '/api/dashboard/summary', { token: ownerLogin.data.token });
  assert.equal(health.status, 200);
});

test('production startup fails clearly when JWT_SECRET is missing', async () => {
  const directory = await createTestDirectory('esk-missing-secret-');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '0',
    DB_FILE: path.join(directory, 'missing-secret.sqlite'),
    OWNER_NAME: 'Owner',
    OWNER_EMAIL: 'owner@example.test',
    OWNER_PASSWORD: 'TestOwnerPassword!123',
  };
  delete env.JWT_SECRET;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Missing-secret process did not exit. Output:\n${output}`));
    }, 5_000);
    child.once('exit', exitCode => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  assert.equal(code, 1);
  assert.match(output, /JWT_SECRET is required/);
  assert.doesNotMatch(output, /TestOwnerPassword!123/);
  await fs.rm(directory, { recursive: true, force: true });
});
