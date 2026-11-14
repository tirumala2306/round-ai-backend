#!/usr/bin/env node
/**
 * Seed / refresh **fictional** demo chart data via the HTTP API.
 *
 * Never load real PHI. Production requires an explicit confirm string.
 *
 * Usage:
 *   # Local (default http://127.0.0.1:8080)
 *   node scripts/seed-test-data.mjs
 *
 *   # Production Fly API
 *   BASE_URL=https://round-ai-backend.fly.dev CONFIRM=SEED_FICTIONAL \
 *     node scripts/seed-test-data.mjs
 *
 *   # Print reset guidance only
 *   node scripts/seed-test-data.mjs --reset-help
 *
 * Env:
 *   BASE_URL          API root (default http://127.0.0.1:8080)
 *   ADMIN_EMAIL       default admin@rounds.test
 *   ADMIN_PASSWORD    default ChangeMe-12345
 *   CONFIRM           must be SEED_FICTIONAL when BASE_URL is not localhost
 */

import { pathToFileURL } from 'node:url';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL || 'admin@rounds.test';
const PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe-12345';
const MARKER_NAME = 'Jordan Hale (fictional)';

function isLocalhost(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

function printResetHelp() {
  console.log(`
Reset guidance (fictional demo only)
====================================
This script is idempotent: it creates "${MARKER_NAME}" only if missing,
then ensures a source, confirmed facts, and Today's plan.

There is no public "delete patient" API. Options to fully reset:

1) Soft refresh (safe on production)
   Re-run this script. It will not duplicate the marker patient.

2) Local empty database
   Stop the server, delete the SQLite file (DB_PATH), start again.
   Empty DB auto-seeds demo users on boot, or run: npm run seed

3) Production full wipe (DESTROYS ALL DATA on the volume — rare)
   Only with explicit ops approval:
     fly ssh console -a round-ai-backend
     # remove /data/roundsai.db then restart the machine
   Or detach/recreate the Fly volume, then redeploy so seedDemo runs once.

Never paste clinical text into tickets. Log status codes only.
`);
}

async function main() {
  if (process.argv.includes('--reset-help') || process.argv.includes('--reset')) {
    printResetHelp();
    if (process.argv.includes('--reset')) {
      console.log('No destructive reset was performed. See options above.');
    }
    return;
  }

  if (!isLocalhost(BASE) && process.env.CONFIRM !== 'SEED_FICTIONAL') {
    console.error('Refusing non-local seed without CONFIRM=SEED_FICTIONAL');
    console.error(`BASE_URL=${BASE}`);
    process.exit(1);
  }

  console.log(`Seeding fictional demo data via ${BASE} …`);

  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  if (login.status !== 200 || !login.json?.token) {
    console.error('Login failed', login.status, login.json?.error?.code || login.text?.slice(0, 200));
    process.exit(1);
  }
  const token = login.json.token;

  const me = await api('GET', '/me', { token });
  const teamId = me.json?.teams?.[0]?.id;
  if (!teamId) {
    console.error('Admin has no team; cannot create patients.');
    process.exit(1);
  }

  const list = await api('GET', '/patients', { token });
  const patients = Array.isArray(list.json) ? list.json : list.json?.patients || [];
  let patient = patients.find((p) => p.display_name === MARKER_NAME);

  if (!patient) {
    const created = await api('POST', '/patients', {
      token,
      body: {
        team_id: teamId,
        display_name: MARKER_NAME,
        room: '411B',
        age_band: '50s',
        sex: 'male',
      },
    });
    if (created.status !== 200 && created.status !== 201) {
      console.error('Create patient failed', created.status, created.json?.error?.code);
      process.exit(1);
    }
    const newId = created.json?.id;
    if (!newId) {
      console.error('Create patient returned no id', created.json);
      process.exit(1);
    }
    patient = { id: newId, display_name: MARKER_NAME };
    console.log('Created', MARKER_NAME, newId);
  } else {
    console.log('Found existing', MARKER_NAME, patient.id);
  }

  const patientId = patient.id;
  const today = new Date().toISOString().slice(0, 10);

  const sources = await api('GET', `/patients/${patientId}/sources`, { token });
  const sourceList = Array.isArray(sources.json) ? sources.json : [];
  if (!sourceList.length) {
    const src = await api('POST', `/patients/${patientId}/sources`, {
      token,
      body: {
        kind: 'progress_note',
        title: 'Seed progress (fictional)',
        event_time: `${today}T08:00:00.000Z`,
        text:
          'Fictional seed note. Patient reports productive cough for three days. '
          + 'Denies chest pain. Creatinine 1.4 mg/dL this morning. Blood cultures pending.',
      },
    });
    if (src.status === 200 || src.status === 201) {
      console.log('Added fictional source', src.json?.id || '');
      const sid = src.json?.id;
      if (sid) {
        const ex = await api('POST', `/patients/${patientId}/sources/${sid}/extract`, { token });
        console.log('Extract facts', ex.status, ex.json?.error?.code || 'ok');
      }
    } else {
      console.warn('Source create skipped', src.status, src.json?.error?.code);
    }
  } else {
    console.log('Sources already present:', sourceList.length);
  }

  const facts = await api('GET', `/patients/${patientId}/facts?status=pending`, { token });
  const pending = Array.isArray(facts.json) ? facts.json : [];
  if (pending.length) {
    const ids = pending.map((f) => f.id).filter(Boolean);
    const rev = await api('POST', `/patients/${patientId}/facts/review`, {
      token,
      body: { fact_ids: ids, status: 'confirmed' },
    });
    console.log('Confirmed pending facts', ids.length, '→', rev.status);
  }

  const plan = await api('PUT', `/patients/${patientId}/plan`, {
    token,
    body: {
      plan_date: today,
      text: 'Continue current care (fictional seed plan).\nRecheck creatinine in the morning.',
    },
  });
  console.log("Today's plan", plan.status === 200 ? 'saved' : `status ${plan.status}`);

  console.log(`
Done (fictional only).
  Resident login: resident@rounds.test / ChangeMe-12345
  Marker patient: ${MARKER_NAME}
  Reset help:     node scripts/seed-test-data.mjs --reset-help
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
