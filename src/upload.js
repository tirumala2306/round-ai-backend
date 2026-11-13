import Busboy from 'busboy';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError, need, str, uid } from './util.js';

const AUDIO = new Set(config.uploads.audioMimes);
const IMAGE = new Set(config.uploads.imageMimes);

export function mimeAllowed(kind, mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (kind === 'audio') return AUDIO.has(m);
  if (kind === 'image') return IMAGE.has(m);
  return false;
}

export function maxBytesFor(kind) {
  return kind === 'audio' ? config.uploads.maxAudioBytes : config.uploads.maxImageBytes;
}

/** Strip data-URL prefix if present; return raw base64 payload. */
export function stripDataUrl(b64) {
  const s = String(b64 || '');
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
}

export function decodeBase64(b64, kind) {
  let buf;
  try { buf = Buffer.from(stripDataUrl(b64), 'base64'); } catch {
    throw new HttpError(400, 'bad_base64', 'file_base64 must be valid base64');
  }
  need(buf.length > 0, 400, 'empty_file', 'Uploaded file is empty');
  need(buf.length <= maxBytesFor(kind), 413, 'too_large', `File exceeds the ${kind} size limit`);
  return buf;
}

/**
 * Parse multipart/form-data into { fields, file: { buffer, mimeType, filename } | null }.
 * Does not log field or file contents (PHI).
 */
export function parseMultipart(req, { maxFileBytes } = {}) {
  const limit = maxFileBytes || Math.max(config.uploads.maxAudioBytes, config.uploads.maxImageBytes);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const ok = (v) => { if (!settled) { settled = true; resolve(v); } };

    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: limit, fields: 20, fieldSize: 64 * 1024 } });
    } catch {
      return fail(new HttpError(400, 'bad_multipart', 'Could not parse multipart body'));
    }

    const fields = {};
    let file = null;
    let truncated = false;

    bb.on('file', (name, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > limit) truncated = true;
        else chunks.push(c);
      });
      stream.on('limit', () => { truncated = true; });
      stream.on('error', () => fail(new HttpError(400, 'bad_upload', 'Upload stream failed')));
      stream.on('end', () => {
        if (truncated || size > limit) {
          fail(new HttpError(413, 'too_large', 'Uploaded file is too large'));
          return;
        }
        file = {
          field: name,
          buffer: Buffer.concat(chunks),
          mimeType: String(info.mimeType || '').toLowerCase().split(';')[0].trim(),
          filename: String(info.filename || 'upload').slice(0, 200),
        };
      });
    });
    bb.on('field', (name, val) => { fields[name] = String(val).slice(0, 10_000); });
    bb.on('error', () => fail(new HttpError(400, 'bad_multipart', 'Could not parse multipart body')));
    bb.on('finish', () => ok({ fields, file }));
    req.pipe(bb);
  });
}

/** Optionally persist raw bytes under data/uploads/. Returns path or null. Never logs contents. */
export function maybeRetainRaw({ buffer, mimeType, kind, patientId }) {
  if (!config.uploads.retainRaw) return null;
  const dir = path.resolve('data/uploads');
  fs.mkdirSync(dir, { recursive: true });
  const ext = (mimeType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const filePath = path.join(dir, `${uid()}_${kind}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/** Delete a retained raw file if present. */
export function deleteRaw(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

/**
 * Resolve an audio|image payload from either JSON body (base64) or multipart upload.
 * Returns { kind, buffer, mimeType, eventTime, sourceKind, retainedPath }.
 */
export function resolveMediaPayload({ body, upload, defaultKind }) {
  const fields = upload?.fields || body || {};
  const kind = str(fields.kind, 20) || defaultKind;
  need(['audio', 'image'].includes(kind), 400, 'bad_kind', 'kind must be audio or image');

  const eventTime = fields.event_time ? str(fields.event_time, 25) : null;
  const sourceKind = fields.source_kind ? str(fields.source_kind, 40) : null;

  let buffer;
  let mimeType;

  if (upload?.file?.buffer?.length) {
    buffer = upload.file.buffer;
    mimeType = upload.file.mimeType;
    need(buffer.length <= maxBytesFor(kind), 413, 'too_large', `File exceeds the ${kind} size limit`);
  } else {
    const b64 = fields.file_base64 || fields.audio_base64 || fields.image_base64;
    need(b64, 400, 'file_required', 'Provide multipart file or file_base64');
    mimeType = str(fields.mime_type || fields.mimeType, 80).toLowerCase();
    need(mimeType, 400, 'mime_required', 'mime_type is required with base64 uploads');
    buffer = decodeBase64(b64, kind);
  }

  need(mimeAllowed(kind, mimeType), 415, 'mime_not_allowed', `MIME type not allowed for ${kind}`);
  const retainedPath = maybeRetainRaw({ buffer, mimeType, kind, patientId: null });
  return { kind, buffer, mimeType, eventTime, sourceKind, retainedPath };
}
