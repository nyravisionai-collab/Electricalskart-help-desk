import crypto from 'node:crypto';
import { get } from './db.js';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

export function createCustomerSessionToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashCustomerSessionToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function authenticateCustomerSession(token) {
  const tokenHash = hashCustomerSessionToken(token);
  if (!tokenHash) return null;
  return get(
    'SELECT id, name, requirement, session_id, created_at, last_active_at FROM customers WHERE session_token_hash = ?',
    [tokenHash],
  );
}

export function customerOwnsConversation(customerId, conversationId) {
  if (!customerId || typeof conversationId !== 'string') return null;
  return get(
    'SELECT * FROM conversations WHERE id = ? AND customer_id = ?',
    [conversationId, customerId],
  );
}

export function customerTokenFromRequest(req) {
  const header = req.headers['x-customer-session'];
  return typeof header === 'string' ? header : '';
}
