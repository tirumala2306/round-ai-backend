import crypto from 'node:crypto';
import { config } from './config.js';
import { get, audit } from './db.js';
import { HttpError } from './util.js';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', config.authSecret).update(data).digest('base64url');

export function signToken(userId) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds }));
  return `${header}.${payload}.${hmac(`${header}.${payload}`)}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(hmac(`${parts[0]}.${parts[1]}`));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch { return null; }
}

export function userFromRequest(req) {
  const h = req.headers.authorization || '';
  const payload = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
  if (!payload) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  const user = get('SELECT id,email,name,role,active FROM users WHERE id=?', payload.sub);
  if (!user || !user.active) throw new HttpError(401, 'unauthenticated', 'Account not active');
  return user;
}

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, 'forbidden', 'Not allowed for your role');
}

/** Team isolation: users only reach patients of teams they belong to (admin role does not bypass this). */
export function authorizePatient(user, patientId) {
  const patient = get('SELECT * FROM patients WHERE id=?', patientId);
  if (!patient) throw new HttpError(404, 'not_found', 'Patient not found');
  const member = get('SELECT 1 AS ok FROM team_members WHERE team_id=? AND user_id=?', patient.team_id, user.id);
  if (!member) {
    audit(user.id, 'access_denied', { patient_id: patientId });
    throw new HttpError(403, 'access_denied', 'You do not have access to this patient');
  }
  return patient;
}

// Simple in-memory login throttle: 5 failures per 15 minutes per email.
const attempts = new Map();
export function throttleCheck(email) {
  const rec = attempts.get(email);
  if (rec && rec.until > Date.now()) throw new HttpError(429, 'too_many_attempts', 'Too many failed attempts. Try again later.');
}
export function throttleFail(email) {
  const rec = attempts.get(email) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) { rec.until = Date.now() + 15 * 60_000; rec.count = 0; }
  attempts.set(email, rec);
}
export const throttleOk = (email) => attempts.delete(email);
