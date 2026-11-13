import { all, get, run } from './db.js';
import { uid, nowIso, jsonParse } from './util.js';

// `source` tells the validator where a section's content may come from:
//   clinician_history  -> history sections (CC/HPI/PMH/meds/allergies/FH/SH/ROS). Text comes ONLY from what the clinician
//                         typed or dictated for THAT section (inputs.history[section.key]); empty -> "[<Title> not entered]"
//   clinician_subjective | clinician_exam | clinician_update | clinician_support | clinician_plan -> only what the clinician typed
//   facts            -> confirmed chart facts only
//   facts_and_exam   -> confirmed facts + clinician exam
// These are PLACEHOLDER templates. Replace with your institution's approved templates via PUT /admin/templates/:key.
export const DEFAULT_TEMPLATES = [
  {
    key: 'admit_hp', title: 'Admission H&P',
    sections: [
      { key: 'chief_complaint', title: 'Chief complaint', source: 'clinician_history' },
      { key: 'hpi', title: 'HPI', source: 'clinician_history' },
      { key: 'pmh', title: 'PMH', source: 'clinician_history' },
      { key: 'medications', title: 'Medications', source: 'clinician_history' },
      { key: 'allergies', title: 'Allergies', source: 'clinician_history' },
      { key: 'family_history', title: 'Family history', source: 'clinician_history' },
      { key: 'social_history', title: 'Social history', source: 'clinician_history' },
      { key: 'ros', title: 'ROS', source: 'clinician_history' },
      { key: 'exam', title: 'Exam', source: 'clinician_exam' },
      { key: 'data', title: 'Data', source: 'facts' },
      { key: 'assessment_plan', title: 'Assessment and Plan', source: 'clinician_plan' },
    ],
  },
  {
    key: 'progress', title: 'Progress note',
    sections: [
      { key: 'subjective', title: 'Subjective', source: 'clinician_subjective' },
      { key: 'objective', title: 'Objective', source: 'facts_and_exam' },
      { key: 'assessment_plan', title: 'Assessment and Plan', source: 'clinician_plan' },
    ],
  },
  {
    key: 'icu', title: 'ICU note',
    sections: [
      { key: 'interval_events', title: 'Interval events', source: 'clinician_update' },
      { key: 'support', title: 'Support (ventilation, pressors, lines)', source: 'clinician_support' },
      { key: 'exam', title: 'Examination', source: 'clinician_exam' },
      { key: 'labs_imaging', title: 'Labs and imaging', source: 'facts' },
      { key: 'assessment_plan', title: 'Assessment and Plan', source: 'clinician_plan' },
    ],
  },
];

export function seedTemplates() {
  for (const t of DEFAULT_TEMPLATES) {
    if (!get('SELECT 1 AS x FROM templates WHERE key=?', t.key)) {
      run('INSERT INTO templates(id,key,version,title,sections,active,created_at) VALUES(?,?,?,?,?,1,?)',
        uid(), t.key, 1, t.title, JSON.stringify(t.sections), nowIso());
    }
  }
}

export function getActiveTemplate(key) {
  const row = get('SELECT * FROM templates WHERE key=? AND active=1 ORDER BY version DESC LIMIT 1', key);
  return row ? { key: row.key, version: row.version, title: row.title, sections: jsonParse(row.sections, []) } : null;
}

export const listTemplates = () =>
  all('SELECT key,version,title,sections,active,created_at FROM templates ORDER BY key,version DESC')
    .map((r) => ({ ...r, sections: jsonParse(r.sections, []) }));

export const SOURCES = ['clinician_history', 'clinician_subjective', 'clinician_exam', 'clinician_update', 'clinician_support', 'clinician_plan', 'facts', 'facts_and_exam'];

export function publishTemplate(key, title, sections) {
  const latest = get('SELECT MAX(version) AS v FROM templates WHERE key=?', key)?.v || 0;
  run('UPDATE templates SET active=0 WHERE key=?', key);
  run('INSERT INTO templates(id,key,version,title,sections,active,created_at) VALUES(?,?,?,?,?,1,?)',
    uid(), key, latest + 1, title, JSON.stringify(sections), nowIso());
  return latest + 1;
}
