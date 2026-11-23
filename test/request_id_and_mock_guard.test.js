import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp, normalizeRequestId } from '../src/server.js';

test('normalizeRequestId keeps safe ids and replaces junk', () => {
  assert.equal(normalizeRequestId('abc-123_XYZ'), 'abc-123_XYZ');
  const junk = normalizeRequestId('Patient Name: John Doe!!!');
  assert.ok(junk);
  assert.notEqual(junk, 'Patient Name: John Doe!!!');
  assert.doesNotMatch(junk, /John|Doe|Patient| /);
});

test('responses expose X-Request-Id and error.request_id', async () => {
  const server = createApp();
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/no-such-route`, {
      headers: { 'X-Request-Id': 'support-ref-42' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-request-id'), 'support-ref-42');
    const body = await res.json();
    assert.equal(body.error.request_id, 'support-ref-42');
    assert.equal(body.error.code, 'not_found');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('production refuses AI_PROVIDER=mock unless ALLOW_MOCK_IN_PRODUCTION', () => {
  const configUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config.js'),
  ).href;
  const run = (env) => spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)});`],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );

  const blocked = run({
    NODE_ENV: 'production',
    AI_PROVIDER: 'mock',
    ALLOW_MOCK_IN_PRODUCTION: 'false',
    AUTH_SECRET: 'test-secret-not-dev-default-xxxxxxxx',
    DB_PATH: '/data/roundsai.db',
  });
  assert.notEqual(blocked.status, 0, blocked.stderr || blocked.stdout);
  assert.match(`${blocked.stderr}${blocked.stdout}`, /AI_PROVIDER=mock is not allowed/);

  const allowed = run({
    NODE_ENV: 'production',
    AI_PROVIDER: 'mock',
    ALLOW_MOCK_IN_PRODUCTION: 'true',
    AUTH_SECRET: 'test-secret-not-dev-default-xxxxxxxx',
    DB_PATH: '/data/roundsai.db',
  });
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
});
