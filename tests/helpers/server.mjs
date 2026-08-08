import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function createTestDirectory(prefix = 'esk-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function startTestServer(options = {}) {
  const port = options.port || await getFreePort();
  const directory = options.directory || await createTestDirectory();
  const dbFile = options.dbFile || path.join(directory, 'helpdesk.sqlite');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DB_FILE: dbFile,
    JWT_SECRET: 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters',
    OWNER_NAME: 'Test Owner',
    OWNER_EMAIL: 'owner@example.test',
    OWNER_PASSWORD: 'TestOwnerPassword!123',
    AI_PROVIDER: 'local',
    CORS_ORIGIN: `http://127.0.0.1:${port}`,
    ...options.env,
  };
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out.\n${logs}`)), 10_000);
    const onData = () => {
      if (logs.includes('listening on')) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited during startup (${code}).\n${logs}`));
    });
  });

  return {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    directory,
    dbFile,
    env,
    getLogs: () => logs,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null) return;
      child.kill(signal);
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

export async function apiRequest(baseUrl, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.customerToken) headers['x-customer-session'] = options.customerToken;
  const response = await fetch(baseUrl + route, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

export function connectSocket(baseUrl, auth) {
  return io(baseUrl, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
}

export function onceEvent(socket, event, options = {}) {
  const timeoutMs = options.timeout || 5_000;
  const predicate = options.predicate || (() => true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for socket event ${event}`));
    }, timeoutMs);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

export async function emitWithAck(socket, event, payload, timeout = 5_000) {
  return socket.timeout(timeout).emitWithAck(event, payload);
}

export async function startCustomer(baseUrl, name, requirement = 'Hello') {
  const result = await apiRequest(baseUrl, '/api/customer/start', {
    body: { name, requirement },
  });
  if (result.status !== 200) throw new Error(`Could not start customer: ${JSON.stringify(result.data)}`);
  return result.data;
}
