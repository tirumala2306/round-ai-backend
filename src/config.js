import fs from 'node:fs';

// Tiny .env loader (no dependency). Real environment variables win.
try {
  const text = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file: fine */ }

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  dbPath: env.DB_PATH || './data/roundsai.db',
  authSecret: env.AUTH_SECRET || 'dev-only-change-me',
  tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS || 8 * 3600),
  // Comma-separated allow-list (admin + Flutter web + localhost). No bare *
  // in production when multiple clients are configured.
  // Example: https://round-ai-admin.vercel.app,https://round-ai-app.vercel.app,http://localhost:5173
  corsOrigin: env.CORS_ORIGIN || '*',
  provider: env.AI_PROVIDER || 'mock', // 'mock' | 'openai'
  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    model: env.OPENAI_MODEL || '',
    // Whisper for Dictate / field mic; override if org requires a different name.
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
    visionModel: env.OPENAI_VISION_MODEL || '',
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },
  ncbi: { apiKey: env.NCBI_API_KEY || '', email: env.NCBI_EMAIL || '', tool: 'roundsai' },
  limits: {
    maxCallsPerUserPerDay: Number(env.MAX_AI_CALLS_PER_USER_PER_DAY || 200),
    maxContextFacts: Number(env.MAX_CONTEXT_FACTS || 300),
    maxEvidenceCandidates: 30,
    modelTimeoutMs: Number(env.MODEL_TIMEOUT_MS || 60000),
    // Global JSON body cap (non-upload routes). Keep small.
    maxBodyBytes: 1_000_000,
    // Intake/transcribe/census-intake only (JSON base64). Multipart uses busboy
    // fileSize = max(audio,image). Default ~35 MiB ≈ 10 MiB image * 4/3 base64.
    maxUploadBodyBytes: Number(env.MAX_UPLOAD_BODY_BYTES || 35_000_000),
  },
  uploads: {
    // PHI: process then delete raw bytes unless explicitly retained.
    retainRaw: env.RETAIN_RAW_UPLOADS === 'true',
    maxAudioBytes: Number(env.MAX_AUDIO_BYTES || 25 * 1024 * 1024),
    maxImageBytes: Number(env.MAX_IMAGE_BYTES || 10 * 1024 * 1024),
    audioMimes: (env.AUDIO_MIMES || 'audio/wav,audio/wave,audio/x-wav,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/x-m4a,audio/webm,audio/ogg,audio/flac').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    imageMimes: (env.IMAGE_MIMES || 'image/jpeg,image/jpg,image/png,image/webp,image/gif').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },
  features: { considerations: env.FEATURE_CONSIDERATIONS === 'true' },
  versions: { prompt: '2026-11-v2', evidencePolicy: '2026-11-v1' },
};

if (env.NODE_ENV === 'production' && config.authSecret === 'dev-only-change-me') {
  throw new Error('AUTH_SECRET must be set in production');
}
