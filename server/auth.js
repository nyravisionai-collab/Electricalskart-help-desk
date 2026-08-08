import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
const TTL = parseInt(process.env.SESSION_TTL_HOURS || '72', 10) * 60 * 60; // seconds

export function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, name: user.name, email: user.email },
    SECRET,
    { expiresIn: TTL }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

export function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

export function comparePassword(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}

// Express middleware — authenticates Bearer token from Authorization header
// (PWA-friendly; no cookie dependence).
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = payload;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}
