import { config } from '../config.js';
import { mockGenerate, mockTranscribe, mockExtractFromImage } from './mock.js';
import { PROMPTS } from './prompts.js';

export class AdapterError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

// Allows tests (or other providers) to swap the network call.
let fetchImpl = (...a) => fetch(...a);
export const setModelFetch = (f) => { fetchImpl = f; };

function parseResponseText(data) {
  return (data.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

async function openaiGenerate({ operation, payload }) {
  const { apiKey, model, baseUrl } = config.openai;
  if (!apiKey || !model) throw new AdapterError('OPENAI_API_KEY and OPENAI_MODEL must be set when AI_PROVIDER=openai');
  const prompt = PROMPTS[operation];
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        store: false, // do not retain clinical inputs on the provider side
        instructions: prompt.system,
        input: `Respond with a single JSON object.\n${JSON.stringify({ task: operation, data: payload })}`,
        text: { format: { type: 'json_object' } },
        max_output_tokens: 4000,
      }),
      signal: AbortSignal.timeout(config.limits.modelTimeoutMs),
    });
  } catch (e) {
    throw new AdapterError(`Model request failed: ${e.name}`, { retryable: true });
  }
  if (!res.ok) {
    throw new AdapterError(`Model provider returned ${res.status}`, { retryable: res.status === 429 || res.status >= 500, status: res.status });
  }
  const data = await res.json();
  const text = parseResponseText(data);
  let json;
  try { json = JSON.parse(text); } catch { throw new AdapterError('Model returned invalid JSON', { retryable: true }); }
  return {
    json,
    model: data.model || model,
    usage: { input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 },
  };
}

/** Speech-to-text. OpenAI: POST /v1/audio/transcriptions. Model from OPENAI_TRANSCRIBE_MODEL. */
async function openaiTranscribe({ audioBase64, mimeType }) {
  const { apiKey, baseUrl, transcribeModel } = config.openai;
  if (!apiKey || !transcribeModel) {
    throw new AdapterError('OPENAI_API_KEY and OPENAI_TRANSCRIBE_MODEL must be set for transcription');
  }
  const bytes = Buffer.from(audioBase64, 'base64');
  // Flutter record package writes .m4a with mime audio/mp4 — Whisper needs a real audio extension.
  const raw = (mimeType.split('/')[1] || 'wav').replace('x-', '').split(';')[0] || 'wav';
  const ext = raw === 'mp4' || raw === 'm4a' ? 'm4a' : raw;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), `audio.${ext}`);
  form.append('model', transcribeModel);
  form.append('response_format', 'json');
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(config.limits.modelTimeoutMs),
    });
  } catch (e) {
    throw new AdapterError(`Transcription request failed: ${e.name}`, { retryable: true });
  }
  if (!res.ok) {
    throw new AdapterError(`Transcription provider returned ${res.status}`, { retryable: res.status === 429 || res.status >= 500, status: res.status });
  }
  const data = await res.json();
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) throw new AdapterError('Transcription returned empty text', { retryable: true });
  return {
    json: { text },
    model: transcribeModel,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Vision OCR / note extraction. OpenAI Responses API with input_image.
 * Model: OPENAI_VISION_MODEL, else OPENAI_MODEL.
 */
async function openaiExtractFromImage({ imageBase64, mimeType }) {
  const { apiKey, baseUrl, model, visionModel } = config.openai;
  const useModel = visionModel || model;
  if (!apiKey || !useModel) {
    throw new AdapterError('OPENAI_API_KEY and OPENAI_VISION_MODEL (or OPENAI_MODEL) must be set for image extraction');
  }
  const prompt = PROMPTS.extract_from_image;
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: useModel,
        store: false,
        instructions: prompt.system,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract clinical text from this image. Respond with one JSON object as specified.' },
            { type: 'input_image', image_url: dataUrl, detail: 'high' },
          ],
        }],
        text: { format: { type: 'json_object' } },
        max_output_tokens: 4000,
      }),
      signal: AbortSignal.timeout(config.limits.modelTimeoutMs),
    });
  } catch (e) {
    throw new AdapterError(`Vision request failed: ${e.name}`, { retryable: true });
  }
  if (!res.ok) {
    throw new AdapterError(`Vision provider returned ${res.status}`, { retryable: res.status === 429 || res.status >= 500, status: res.status });
  }
  const data = await res.json();
  const text = parseResponseText(data);
  let json;
  try { json = JSON.parse(text); } catch { throw new AdapterError('Vision returned invalid JSON', { retryable: true }); }
  return {
    json,
    model: data.model || useModel,
    usage: { input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 },
  };
}

/** One bounded retry for transient failures. */
export async function generate(args) {
  const fn = config.provider === 'openai' ? openaiGenerate : mockGenerate;
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof AdapterError && e.retryable) return fn(args);
    throw e;
  }
}

export async function transcribe(args) {
  const fn = config.provider === 'openai' ? openaiTranscribe : mockTranscribe;
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof AdapterError && e.retryable) return fn(args);
    throw e;
  }
}

export async function extractFromImage(args) {
  const fn = config.provider === 'openai' ? openaiExtractFromImage : mockExtractFromImage;
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof AdapterError && e.retryable) return fn(args);
    throw e;
  }
}

export const providerName = () => config.provider;
