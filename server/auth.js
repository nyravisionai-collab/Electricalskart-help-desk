import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { get } from './db.js';

const JWT_ISSUER = 'electricalskart-helpdesk';
const JWT_AUDIENCE = 'electricalskart-staff';
const MIN_SECRET_BYTES = 32;
const FORBIDDEN_SECRETS = new Set([
  'dev-insecure-secret',
  'change-me-to-a-long-random-string',
  'changeme',
  'secret',
]);

let validatedConfig = null;

export function validateAuthConfiguration(environment = process.env) {
  const secret = typeof environment.JWT_SECRET === 'string' ? environment.JWT_SECRET.trim() : '';
  if (!secret) {
    throw new Error('JWT_SECRET is required. Generate a cryptographically random secret of at least 32 bytes.');
  }
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES || FORBIDDEN_SECRETS.has(secret.toLowerCase())) {
    throw new Error('JWT_SECRET must be a non-placeholder secret containing at least 32 bytes.');
  }
  const ttlHours = Number.parseInt(environment.SESSION_TTL_HOURS || '12', 10);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    throw new Error('SESSION_TTL_HOURS must be an integer between 1 and 168.');
  }
  const config = { secret, ttlSeconds: ttlHours * 60 * 60 };
  if (environment === process.env) validatedConfig = config;
  return config;
}

function config() {
  return validatedConfig || validateAuthConfiguration();
}

export function signToken(user, options = {}) {
  const { secret, ttlSeconds } = config();
  return jwt.sign(
    {
      uid: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      tokenType: 'staff',
    },
    secret,
    {
      algorithm: 'HS256',
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
      expiresIn: options.expiresIn ?? ttlSeconds,
    },
  );
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  try {
    const { secret } = config();
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
    });
    return payload?.tokenType === 'staff' ? payload : null;
  } catch {
    return null;
  }
}

export function authenticateStaffToken(token) {
  const payload = verifyToken(token);
  if (!payload?.uid) return null;
  const user = get(
    "SELECT id, name, email, role, status FROM users WHERE id = ? AND status = 'active'",
    [payload.uid],
  );
  if (!user || !['owner', 'agent'].includes(user.role)) return null;
  return {
    uid: user.id,
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

export function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const user = authenticateStaffToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  return next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    return next();
  };
}
