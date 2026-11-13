import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const need = (cond, status, code, message, extra) => { if (!cond) throw new HttpError(status, code, message, extra); };
export const str = (v, max = 20000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const jsonParse = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };

export const numbersIn = (text) => String(text ?? '').match(/\d+(?:\.\d+)?/g) || [];

/** Numbers that appear in `text` but not in `allowedText` (used to catch invented values). */
export function unsupportedNumbers(text, allowedText) {
  const allowed = new Set(numbersIn(allowedText));
  return [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
}

export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));
