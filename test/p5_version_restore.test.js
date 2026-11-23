process.env.DB_PATH = ':memory:';
process.env.AI_PROVIDER = 'mock';
process.env.AUTH_SECRET = 'test-secret';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const { seedDemo, DEMO_PASSWORD } = await import('../src/seed.js');

let server;
let base;
let seed;
let resident;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  server = createApp();
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  seed = await seedDemo();
  const login = await api('POST', '/auth/login', {
    body: { email: 'resident@rounds.test', password: DEMO_PASSWORD },
  });
  resident = login.json.token;
});
after(() => server.close());

test('P5: note version history and restore marks manually_edited', async () => {
  const created = await api('POST', `/patients/${seed.patientId}/notes`, {
    token: resident,
    body: {
      note_type: 'progress',
      note_date: '2026-09-02',
      subjective: 'Day 1 subjective.',
    },
  });
  assert.equal(created.status, 200);
  const id = created.json.artifact_id;

  const v1 = await api('PATCH', `/artifacts/${id}`, {
    token: resident,
    body: {
      sections: [{ key: 'subjective', text: 'Edited once.' }],
    },
  });
  assert.equal(v1.status, 200);

  const v2 = await api('PATCH', `/artifacts/${id}`, {
    token: resident,
    body: {
      sections: [{ key: 'subjective', text: 'Edited twice.' }],
    },
  });
  assert.equal(v2.status, 200);
  assert.match(
    v2.json.content.sections.find((s) => s.key === 'subjective').text,
    /twice/,
  );

  const versions = await api('GET', `/artifacts/${id}/versions`, {
    token: resident,
  });
  assert.equal(versions.status, 200);
  assert.ok(Array.isArray(versions.json));
  assert.ok(versions.json.length >= 2);

  const earliest = versions.json[0].version;
  const restored = await api(
    'POST',
    `/artifacts/${id}/versions/${earliest}/restore`,
    { token: resident },
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.json.review_state, 'draft');
  const subj = restored.json.content.sections.find((s) => s.key === 'subjective');
  assert.equal(subj.manually_edited, true);
  assert.equal(subj.edited, true);

  const after = await api('GET', `/artifacts/${id}/versions`, {
    token: resident,
  });
  assert.ok(after.json.length > versions.json.length);
});
