import { pathToFileURL } from 'node:url';
import { openDb, run, get, tx } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { uid, nowIso } from './util.js';
import { seedTemplates } from './templates.js';
import { seedDemoIcdIfEmpty } from './icd.js';
import { seedExampleCheckRules } from './check_rules.js';
import { mockGenerate } from './ai/mock.js';
import { validateExtractFacts } from './ai/validators.js';
import { ensurePatientChannel, ensureTeamChannel } from './chat.js';

export const DEMO_PASSWORD = 'ChangeMe-12345';

const SOURCES = [
  { kind: 'admission_note', title: 'Admission note', event_time: '2026-08-29T08:00', text: '68-year-old woman admitted with community-acquired pneumonia. Temperature 38.6 C on arrival. SpO2 93% on room air. Creatinine 0.9 mg/dL. No chest pain. Started on ceftriaxone and azithromycin.' },
  { kind: 'overnight_event', title: 'Overnight event', event_time: '2026-08-30T22:00', text: 'Patient developed increasing oxygen need overnight. SpO2 88% on room air. Started on 2 L nasal cannula. Urine output 20 mL/hr over 6 hours. Creatinine 1.8 mg/dL.' },
  { kind: 'lab_review', title: 'Morning labs', event_time: '2026-08-31T06:00', text: 'Creatinine 2.1 mg/dL. Possible acute kidney injury. Blood cultures pending. No fever overnight.' },
];

/** All data here is fictional. Never put real patient data into a development database. */
export async function seedDemo() {
  seedTemplates();
  seedDemoIcdIfEmpty();
  seedExampleCheckRules();
  if (get('SELECT 1 AS x FROM users LIMIT 1')) return null;
  const teamA = uid(); const teamB = uid();
  const admin = uid(); const resident = uid(); const other = uid();
  const now = nowIso();
  const pw = hashPassword(DEMO_PASSWORD);
  tx(() => {
    run('INSERT INTO teams(id,name) VALUES(?,?)', teamA, 'Internal Medicine Team A');
    run('INSERT INTO teams(id,name) VALUES(?,?)', teamB, 'Internal Medicine Team B');
    for (const [id, email, name, role] of [[admin, 'admin@rounds.test', 'Demo Admin', 'admin'], [resident, 'resident@rounds.test', 'Demo Resident', 'resident'], [other, 'other@rounds.test', 'Other Team Resident', 'resident']]) {
      run('INSERT INTO users(id,email,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)', id, email, name, role, pw, now);
    }
    run('INSERT INTO team_members(team_id,user_id) VALUES(?,?)', teamA, resident);
    run('INSERT INTO team_members(team_id,user_id) VALUES(?,?)', teamA, admin);
    run('INSERT INTO team_members(team_id,user_id) VALUES(?,?)', teamB, other);
  });
  const patientId = uid();
  run('INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,revision,created_at) VALUES(?,?,?,?,?,?,?,1,?)', patientId, teamA, 'Rosa Martinez (fictional)', '509A', '60s', 'female', 10, now);
  ensureTeamChannel({ teamId: teamA, createdBy: admin });
  ensureTeamChannel({ teamId: teamB, createdBy: other });
  ensurePatientChannel({ patient: get('SELECT * FROM patients WHERE id=?', patientId), createdBy: admin });
  for (const s of SOURCES) {
    const sid = uid();
    run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)', sid, patientId, s.kind, s.title, s.event_time, now, s.text);
    const { json } = await mockGenerate({ operation: 'extract_facts', payload: { source: { ...s, id: sid } } });
    const { output } = validateExtractFacts(json, { ...s, id: sid });
    for (const f of output.facts) {
      run(`INSERT INTO facts(id,patient_id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,revision,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,'confirmed',1,?)`, uid(), patientId, f.label, f.value, f.unit, f.event_time, sid, f.source_passage, f.assertion, now);
    }
  }
  return { teamA, teamB, admin, resident, other, patientId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openDb(config.dbPath);
  const out = await seedDemo();
  console.log(out ? `Seeded demo data.\n  admin@rounds.test / resident@rounds.test / other@rounds.test\n  password: ${DEMO_PASSWORD}` : 'Database already has users; nothing seeded.');
}
