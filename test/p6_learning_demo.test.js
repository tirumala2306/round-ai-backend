process.env.DB_PATH = ':memory:';
process.env.AI_PROVIDER = 'mock';
process.env.AUTH_SECRET = 'test-secret';
process.env.DEMO_MODE = 'true';
process.env.DEMO_CLOCK_ISO = '2026-09-02T12:00:00.000Z';
process.env.DEMO_APPROVE_CHECK_RULES = 'true';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const { today, nowIso, demoModeEnabled } = await import('../src/util.js');
const { createApp } = await import('../src/server.js');
const { seedDemo, DEMO_PASSWORD } = await import('../src/seed.js');
const { all } = await import('../src/db.js');
const { topicKey } = await import('../src/learning.js');

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
  assert.equal(demoModeEnabled(), true);
  assert.equal(today(), '2026-09-02');
  assert.match(nowIso(), /^2026-09-02T12:00:00/);

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

test('P6: health exposes demo_mode and demo_clock', async () => {
  const h = await api('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.demo_mode, true);
  assert.equal(h.json.demo_clock, '2026-09-02T12:00:00.000Z');
  assert.match(h.json.time, /^2026-09-02T12:00:00/);
});

test('P6: each Rosa census topic has ≥5 approved bank questions', () => {
  for (const topic of [
    'Elevated Pulse',
    'community-acquired pneumonia',
    'acute kidney injury',
  ]) {
    const n = all(
      "SELECT id FROM mcqs WHERE topic_key=? AND status='approved' AND source='human'",
      topicKey(topic),
    ).length;
    assert.ok(n >= 5, `${topic} bank depth ${n} < 5`);
  }
});

test('P6: teaching plan includes bank_count and uses demo clock date', async () => {
  const plan = await api('GET', '/teaching/plan', { token: resident });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.date, '2026-09-02');
  assert.ok(Array.isArray(plan.json.topics));
  assert.ok(plan.json.topics.length >= 1);
  for (const t of plan.json.topics) {
    assert.equal(typeof t.bank_count, 'number');
  }
  const pulse = plan.json.topics.find((t) => /elevated pulse/i.test(t.topic));
  assert.ok(pulse);
  assert.ok(pulse.bank_count >= 5);
});

test('P6: pneumonia and AKI check-rules are demo-approved', () => {
  const approved = all("SELECT name FROM check_rules WHERE status='approved'");
  assert.ok(approved.some((r) => /pneumonia/i.test(r.name)));
  assert.ok(approved.some((r) => /AKI|kidney/i.test(r.name)));
});
