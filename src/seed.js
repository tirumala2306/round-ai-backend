import { pathToFileURL } from 'node:url';
import { openDb, run, get, all, tx } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { uid, nowIso } from './util.js';
import { seedTemplates } from './templates.js';
import { seedDemoIcdIfEmpty } from './icd.js';
import { seedExampleCheckRules, ensureDemoApprovedCheckRules } from './check_rules.js';
import { mockGenerate } from './ai/mock.js';
import { validateExtractFacts, isIdentityFact } from './ai/validators.js';
import { ensurePatientChannel, ensureTeamChannel } from './chat.js';
import { topicKey } from './learning.js';

export const DEMO_PASSWORD = 'ChangeMe-12345';

const ROSA_SOURCES = [
  { kind: 'admission_note', title: 'Admission note', event_time: '2026-08-29T08:00', text: '68-year-old woman admitted with community-acquired pneumonia. Temperature 38.6 C on arrival. SpO2 93% on room air. Creatinine 0.9 mg/dL. No chest pain. Started on ceftriaxone and azithromycin.' },
  { kind: 'overnight_event', title: 'Overnight event', event_time: '2026-08-30T22:00', text: 'Patient developed increasing oxygen need overnight. SpO2 88% on room air. Started on 2 L nasal cannula. Pulse 112 bpm. Urine output 20 mL/hr over 6 hours. Creatinine 1.8 mg/dL.' },
  { kind: 'lab_review', title: 'Morning labs', event_time: '2026-08-31T06:00', text: 'Creatinine 2.1 mg/dL. Possible acute kidney injury. Blood cultures pending. No fever overnight. Pulse 98 bpm.' },
];

const ALEX_SOURCES = [
  { kind: 'admission_note', title: 'Admission note', event_time: '2026-08-30T10:00', text: '52-year-old man admitted with community-acquired pneumonia. Productive cough for three days. SpO2 94% on room air. Temperature 38.1 C.' },
];

const ELEVATED_PULSE_OPTIONS = [
  'Volume status and oxygen delivery before attributing tachycardia to infection alone',
  'Immediate cardioversion for presumed unstable SVT',
  'Stopping antibiotics to reduce drug fever',
  'Ignoring pulse until blood cultures return',
  'Ordering an echocardiogram before examining the patient at the bedside',
];
const ELEVATED_PULSE_EXPLANATIONS = [
  'Tachycardia with rising oxygen need and falling urine output warrants volume and gas-exchange assessment; the pulse is a clue, not a diagnosis.',
  'Cardioversion is for unstable arrhythmia with clear criteria, not the first step from this vignette alone.',
  'Antibiotics are treating pneumonia; stopping them is not indicated for this finding.',
  'Pending cultures do not justify ignoring a new vital-sign change.',
  'Imaging can wait until bedside volume and oxygen delivery are assessed.',
];

const ELEVATED_PULSE_EVIDENCE = [
  { pmid: '35121615', label: 'Surviving Sepsis Campaign guidelines (oxygen delivery / perfusion context)' },
  { pmid: '32085850', label: 'Approach to the patient with unexplained tachycardia (educational review)' },
];

/** ≥5 approved human bank questions per demo topic (Prompt 8 P6). */
const DEMO_TOPIC_BANKS = {
  'Elevated Pulse': [
    {
      vignette: 'A 68-year-old woman with community-acquired pneumonia develops SpO2 88% on room air overnight and is placed on 2 L nasal cannula. Pulse is 112 bpm. Creatinine has risen from 0.9 to 1.8 mg/dL with low urine output.',
      question: 'Which next bedside assessment best clarifies the tachycardia in this context?',
      options: ELEVATED_PULSE_OPTIONS,
      correctIndex: 0,
      explanations: ELEVATED_PULSE_EXPLANATIONS,
      learningObjective: 'Connect elevated pulse to oxygen delivery and volume using chart facts.',
      evidence: ELEVATED_PULSE_EVIDENCE,
    },
    {
      vignette: 'Same patient: pulse 112 bpm on 2 L nasal cannula after overnight desaturation to SpO2 88% on room air. Blood pressure is stable.',
      question: 'Which statement best reflects how to teach this finding on rounds?',
      options: [
        'Treat tachycardia as a sign to integrate gas exchange and volume, not a rhythm diagnosis by itself',
        'Label SVT and cardiovert before examining the patient',
        'Ignore until the discharge summary',
        'Attribute solely to anxiety without vitals context',
        'Assume drug fever from antibiotics without reviewing vitals',
      ],
      correctIndex: 0,
      explanations: [
        'Teaching should connect the pulse to oxygen delivery and volume using the documented facts.',
        'Cardioversion without instability criteria is not supported by this vignette.',
        'A new vital-sign change belongs in today’s assessment.',
        'Anxiety is not documented; do not invent unsupported explanations.',
        'Drug fever is not established from this vignette alone.',
      ],
      learningObjective: 'Teach tachycardia as a systemic clue, not a freestanding rhythm diagnosis.',
      evidence: ELEVATED_PULSE_EVIDENCE,
    },
    {
      vignette: 'Pulse 118 bpm with SpO2 90% on 2 L NC and urine output 15 mL/hr. No chest pain is documented.',
      question: 'What is the most appropriate first teaching point for learners?',
      options: [
        'Link pulse, oxygen need, and oliguria before naming a rhythm',
        'Start amiodarone for presumed AF with RVR',
        'Discharge home because BP is normal',
        'Order CT pulmonary angiogram before examining the patient',
        'Attribute tachycardia to caffeine without chart support',
      ],
      correctIndex: 0,
      explanations: [
        'The vignette supports integrating perfusion and gas exchange; rhythm labeling is secondary.',
        'Amiodarone is not first-line teaching from these facts alone.',
        'Worsening oxygen need and oliguria argue against early discharge framing.',
        'CTPA can wait until bedside assessment is complete.',
        'Caffeine is not documented.',
      ],
      learningObjective: 'Prioritize oxygen delivery and volume clues over premature rhythm labels.',
      evidence: ELEVATED_PULSE_EVIDENCE,
    },
    {
      vignette: 'Overnight pulse rose from 88 to 112 bpm as oxygen was escalated from room air to 2 L NC.',
      question: 'Which documented trend best contextualizes the elevated pulse?',
      options: [
        'Rising oxygen requirement concurrent with tachycardia',
        'Pending blood cultures alone',
        'Admission temperature from three days ago',
        'Family history not recorded in the chart',
        'Insurance status',
      ],
      correctIndex: 0,
      explanations: [
        'Concurrent oxygen escalation is the most relevant documented trend.',
        'Cultures do not explain the vital-sign change by themselves.',
        'Remote admission fever is weaker context than today’s oxygen trend.',
        'Missing family history is not a substitute for vitals context.',
        'Insurance is irrelevant to clinical teaching of the pulse.',
      ],
      learningObjective: 'Anchor tachycardia teaching to concurrent oxygen and volume trends.',
      evidence: ELEVATED_PULSE_EVIDENCE,
    },
    {
      vignette: 'Learner proposes “anxiety” as the sole cause of pulse 112 bpm with SpO2 88% on room air and oliguria.',
      question: 'How should the attending respond?',
      options: [
        'Require volume and gas-exchange assessment before accepting anxiety as the explanation',
        'Agree and stop reviewing vitals',
        'Order psychiatry consult before examining lungs',
        'Ignore oliguria until discharge',
        'Stop antibiotics immediately for presumed drug fever',
      ],
      correctIndex: 0,
      explanations: [
        'Anxiety is not an adequate sole explanation given hypoxemia and oliguria.',
        'Stopping vitals review abandons core bedside teaching.',
        'Psychiatry is not the first step for this constellation.',
        'Oliguria with rising creatinine belongs in today’s workup.',
        'Drug fever is not established here.',
      ],
      learningObjective: 'Reject unsupported single-cause explanations when hard vitals conflict.',
      evidence: ELEVATED_PULSE_EVIDENCE,
    },
  ],
  'community-acquired pneumonia': [
    {
      vignette: 'Admitted with CAP on ceftriaxone and azithromycin. SpO2 fell overnight from 93% RA to 88% RA.',
      question: 'What is the most appropriate next framing on rounds?',
      options: [
        'Worsening gas exchange — reassess oxygen need, exam, and whether coverage remains appropriate',
        'Ignore SpO2 until cultures finalize',
        'Stop all antibiotics for presumed allergy',
        'Diagnose PE without further assessment',
        'Discharge because fever resolved yesterday',
      ],
      correctIndex: 0,
      explanations: [
        'Falling SpO2 is a clinical change that needs reassessment of support and plan.',
        'Cultures do not justify ignoring hypoxemia.',
        'No allergy is documented.',
        'PE may be considered later but is not the first framing.',
        'Prior fever resolution does not override new hypoxemia.',
      ],
      learningObjective: 'Treat oxygen deterioration as an active reassessment trigger in CAP.',
      evidence: [{ pmid: '35121615', label: 'Surviving Sepsis / critical care oxygen delivery context' }],
    },
    {
      vignette: 'CAP day 2: afebrile, still productive cough, SpO2 94% on RA, cultures pending.',
      question: 'Which teaching point is most accurate?',
      options: [
        'Clinical trajectory and oxygen need matter more than a single pending culture result',
        'Pending cultures mean antibiotics must stop today',
        'Afebrile status alone proves cure',
        'Ignore cough if SpO2 is normal once',
        'Switch to linezolid without a reason',
      ],
      correctIndex: 0,
      explanations: [
        'Teaching should emphasize trajectory over a single lab pending state.',
        'Stopping antibiotics solely for pending cultures is not supported.',
        'Afebrile status is necessary but not sufficient for “cured”.',
        'Symptoms still inform the plan.',
        'Escalation needs a clear indication.',
      ],
      learningObjective: 'Balance cultures with clinical trajectory in CAP teaching.',
      evidence: [{ pmid: '35121615', label: 'Surviving Sepsis / infection reassessment context' }],
    },
    {
      vignette: 'CAP with rising oxygen need and tachycardia; no chest pain documented.',
      question: 'Best next bedside emphasis?',
      options: [
        'Exam and oxygen delivery before expanding the differential blindly',
        'Immediate intubation without assessment',
        'Stop imaging forever',
        'Attribute everything to anxiety',
        'Hold oxygen to “test reserve” without a plan',
      ],
      correctIndex: 0,
      explanations: [
        'Bedside exam and oxygen support come before speculative expansion.',
        'Intubation criteria are not met by this stem alone.',
        'Imaging decisions remain clinical.',
        'Anxiety is unsupported.',
        'Holding oxygen without a plan is unsafe teaching.',
      ],
      learningObjective: 'Ground CAP deterioration in bedside oxygen assessment.',
      evidence: [{ pmid: '35121615', label: 'Critical care oxygen / perfusion teaching' }],
    },
    {
      vignette: 'CAP on appropriate empiric therapy; blood cultures still pending on day 2.',
      question: 'How should learners interpret pending cultures?',
      options: [
        'Pending ≠ negative — continue clinical monitoring while cultures mature',
        'Pending means the organism is resistant',
        'Pending means pneumonia is viral',
        'Pending means stop ceftriaxone immediately',
        'Pending means no further vitals needed',
      ],
      correctIndex: 0,
      explanations: [
        'Pending cultures require continued clinical vigilance, not assumptions.',
        'Resistance is not established by “pending”.',
        'Viral etiology is not proven by pending cultures.',
        'Stopping therapy without a reason is incorrect.',
        'Vitals remain essential.',
      ],
      learningObjective: 'Separate culture timing from clinical decision-making.',
      evidence: [{ pmid: '35121615', label: 'Infection reassessment principles' }],
    },
    {
      vignette: 'CAP improving on oxygen; learner wants to add vancomycin “just in case”.',
      question: 'Best attending response?',
      options: [
        'Ask for a specific indication; avoid unnecessary broadening without a reason',
        'Always add vancomycin on day 2 of CAP',
        'Stop all antibiotics because the patient looks better',
        'Ignore MRSA risk factors if mentioned',
        'Order vancomycin levels before deciding whether to start',
      ],
      correctIndex: 0,
      explanations: [
        'Stewardship teaching: broaden only with an indication.',
        'Routine vancomycin is not standard for uncomplicated CAP.',
        'Clinical improvement does not automatically end therapy.',
        'Risk factors still matter when present.',
        'Levels apply after therapy is indicated.',
      ],
      learningObjective: 'Teach antibiotic stewardship alongside CAP recovery.',
      evidence: [{ pmid: '35121615', label: 'Infection management / stewardship context' }],
    },
  ],
  'acute kidney injury': [
    {
      vignette: 'Creatinine rose from 0.9 to 2.1 mg/dL over two days during diuresis with urine output 20 mL/hr.',
      question: 'What is the most appropriate framing of this creatinine change for rounds?',
      options: [
        'Possible acute kidney injury with low urine output — review volume status and nephrotoxins',
        'Chronic kidney disease stage 5 requiring immediate dialysis',
        'Lab error; ignore until the next admission',
        'Expected rise from antibiotics alone',
        'Ignore oliguria until the next discharge summary',
      ],
      correctIndex: 0,
      explanations: [
        'A clear rise with oliguria is AKI until proven otherwise; volume and toxin review are core.',
        'Nothing in the vignette establishes CKD stage 5 or an immediate dialysis indication.',
        'Do not discard a verified trend without clinical review.',
        'Antibiotics can contribute but do not make the rise “expected” without assessment.',
        'Oliguria with a rising creatinine belongs in today’s assessment, not deferred to discharge.',
      ],
      learningObjective: 'Frame creatinine rise with oliguria as AKI requiring volume/toxin review.',
      evidence: [],
    },
    {
      vignette: 'AKI with Cr 2.1 and urine 20 mL/hr; ACE inhibitor and NSAID are on the med list.',
      question: 'Which action belongs in today’s plan teaching?',
      options: [
        'Review and hold nephrotoxins while addressing volume',
        'Increase the NSAID dose for pain',
        'Ignore meds until discharge',
        'Start another ACE inhibitor',
        'Force fluids without examining volume status',
      ],
      correctIndex: 0,
      explanations: [
        'Nephrotoxin review is a core AKI teaching point.',
        'Increasing NSAID worsens injury risk.',
        'Med review is not optional in AKI.',
        'Adding ACE inhibitor is inappropriate here.',
        'Volume exam should guide fluids.',
      ],
      learningObjective: 'Pair AKI teaching with nephrotoxin review.',
      evidence: [],
    },
    {
      vignette: 'Cr rose overnight; blood pressure is low-normal and lungs are clear.',
      question: 'Best next emphasis?',
      options: [
        'Bedside volume assessment and urine output trend',
        'Immediate dialysis without indication',
        'Stop measuring creatinine',
        'Assume prerenal forever without reassessment',
        'Attribute solely to lab variation',
      ],
      correctIndex: 0,
      explanations: [
        'Volume and UOP contextualize the creatinine change.',
        'Dialysis needs clear indications.',
        'Trends require continued labs.',
        'Prerenal is a hypothesis, not a permanent label.',
        'Do not dismiss a clear rise as variation alone.',
      ],
      learningObjective: 'Use volume and UOP to teach AKI classification.',
      evidence: [],
    },
    {
      vignette: 'Learner calls every creatinine rise “CKD”.',
      question: 'Correct teaching correction?',
      options: [
        'Distinguish acute rise from chronic baseline using the documented trend',
        'Agree that all rises are CKD',
        'Never document creatinine again',
        'Treat as UTI without urine data',
        'Blame anxiety for the lab value',
      ],
      correctIndex: 0,
      explanations: [
        'AKI vs CKD hinges on the time course in the chart.',
        'Blanketing CKD is incorrect teaching.',
        'Labs remain necessary.',
        'UTI needs supporting data.',
        'Anxiety does not explain creatinine.',
      ],
      learningObjective: 'Separate AKI from CKD using documented timelines.',
      evidence: [],
    },
    {
      vignette: 'AKI improving after holding diuretics; Cr falling and UOP rising.',
      question: 'Best teaching takeaway?',
      options: [
        'Reassess volume and meds as the creatinine trajectory changes',
        'Restart all nephrotoxins immediately',
        'Ignore improving UOP',
        'Label permanent dialysis need',
        'Stop following labs because the patient feels better',
      ],
      correctIndex: 0,
      explanations: [
        'Trajectory-driven reassessment is the lesson.',
        'Blind restart of nephrotoxins is unsafe.',
        'UOP improvement is meaningful.',
        'Permanent dialysis is not supported.',
        'Labs still guide recovery.',
      ],
      learningObjective: 'Teach AKI recovery as an active reassessment process.',
      evidence: [],
    },
  ],
};

function seedElevatedPulseMcqs({ adminId, now }) {
  ensureTopicBankDepth('Elevated Pulse', { adminId, now, min: 5 });
}

function ensureTopicBankDepth(topic, { adminId, now, min = 5 } = {}) {
  const specs = DEMO_TOPIC_BANKS[topic] || [];
  if (!specs.length || !adminId) return;
  const key = topicKey(topic);
  const rows = all(
    "SELECT id, content FROM mcqs WHERE topic_key=? AND status='approved' AND source='human'",
    key,
  );
  const seenQuestions = new Set(
    rows.map((row) => {
      try {
        return String(JSON.parse(row.content || '{}').question || '').trim().toLowerCase();
      } catch {
        return '';
      }
    }).filter(Boolean),
  );
  let added = 0;
  for (const spec of specs) {
    if (rows.length + added >= min) break;
    const q = String(spec.question || '').trim().toLowerCase();
    if (!q || seenQuestions.has(q)) continue;
    seedApprovedMcq({
      adminId,
      topic,
      vignette: spec.vignette,
      question: spec.question,
      options: spec.options,
      correctIndex: spec.correctIndex,
      explanations: spec.explanations,
      learningObjective: spec.learningObjective,
      evidence: spec.evidence || [],
      now: now || nowIso(),
    });
    seenQuestions.add(q);
    added += 1;
  }
  if (added) console.log(`Seeded/backfilled ${added} approved MCQ(s) for ${topic} (target ≥${min}).`);
}

function ensureDemoLearningBanks() {
  const admin = get("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!admin) {
    console.warn('ensureDemoLearningBanks skipped: no admin user');
    return;
  }
  const now = nowIso();
  for (const topic of Object.keys(DEMO_TOPIC_BANKS)) {
    if (topic === 'Elevated Pulse') continue; // handled + normalized below
    ensureTopicBankDepth(topic, { adminId: admin.id, now, min: 5 });
  }
  ensureElevatedPulseBank();
}

/** Admin-approved curated reads with real PubMed URLs (no fictional domains). */
function ensureElevatedPulseCuratedReads(adminId) {
  const key = topicKey('Elevated Pulse');
  const existing = get('SELECT id FROM curated_reads WHERE topic_key=? AND approved=1 LIMIT 1', key);
  if (existing) return;
  const now = nowIso();
  const rows = [
    {
      title: 'Surviving Sepsis Campaign: International Guidelines for Management of Sepsis and Septic Shock 2021',
      citation: 'Evans L et al. Crit Care Med. 2021;49(11):e1063-e1143.',
      pmid: '35121615',
      why: 'When tachycardia accompanies hypoxemia and oliguria, assess perfusion and oxygen delivery systematically before attributing pulse to infection alone.',
    },
    {
      title: 'Approach to the patient with unexplained tachycardia',
      citation: 'May JE et al. educational review — PubMed 32085850.',
      pmid: '32085850',
      why: 'Supports teaching that tachycardia is a clue requiring volume, oxygen, and bedside context—not an automatic rhythm label.',
    },
  ];
  for (const r of rows) {
    run(
      `INSERT INTO curated_reads(id,topic,topic_key,title,citation,url,pmid,why_it_matters,added_by,approved,approved_by,approved_at,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      uid(), 'Elevated Pulse', key, r.title, r.citation,
      `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`, r.pmid, r.why, adminId, adminId, now, now,
    );
  }
  console.log('Seeded curated high-yield reads for Elevated Pulse.');
}

/** Normalize legacy Elevated Pulse rows + ensure curated reads (bank depth via ensureDemoLearningBanks). */
function ensureElevatedPulseBank() {
  const key = topicKey('Elevated Pulse');
  const admin = get("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!admin) {
    console.warn('ensureElevatedPulseBank skipped: no admin user');
    return;
  }
  ensureTopicBankDepth('Elevated Pulse', { adminId: admin.id, now: nowIso(), min: 5 });
  const rows = all("SELECT id, content FROM mcqs WHERE topic_key=? AND status='approved' AND source='human'", key);
  // Patch undersized / legacy answer shapes in place (keep ids so attempts stay valid).
  for (const row of rows) {
    let content;
    try {
      content = JSON.parse(row.content || '{}');
    } catch {
      content = {};
    }
    let dirty = false;
    if (!Array.isArray(content.options) || content.options.length < 5) {
      content.options = ELEVATED_PULSE_OPTIONS;
      content.explanations = ELEVATED_PULSE_EXPLANATIONS;
      if (!Number.isInteger(content.correct_index)) content.correct_index = 0;
      dirty = true;
    }
    const letters = ['A', 'B', 'C', 'D', 'E'];
    if (!letters.includes(String(content.answer || '').toUpperCase())) {
      const idx = Number.isInteger(content.correct_index) ? content.correct_index : 0;
      content.answer = letters[idx] || 'A';
      content.correct_index = idx;
      dirty = true;
    }
    if (!content.option_explanations || typeof content.option_explanations !== 'object') {
      const option_explanations = {};
      (content.explanations || ELEVATED_PULSE_EXPLANATIONS).forEach((text, i) => {
        if (i < letters.length && text) option_explanations[letters[i]] = text;
      });
      content.option_explanations = option_explanations;
      content.explanation = option_explanations[content.answer] || content.explanation || '';
      dirty = true;
    }
    if (!Array.isArray(content.evidence) || !content.evidence.length) {
      content.evidence = ELEVATED_PULSE_EVIDENCE;
      dirty = true;
    }
    if (!content.learning_objective) {
      content.learning_objective = 'Connect elevated pulse to oxygen delivery and volume using chart facts.';
      dirty = true;
    }
    if (dirty) run('UPDATE mcqs SET content=? WHERE id=?', JSON.stringify(content), row.id);
  }
  ensureElevatedPulseCuratedReads(admin.id);
}

function acceptedCodeFromProblem(row) {
  if (!row?.code_suggestion) return null;
  try {
    const sug = typeof row.code_suggestion === 'string'
      ? JSON.parse(row.code_suggestion)
      : row.code_suggestion;
    const code = sug?.code ? String(sug.code).trim().toUpperCase() : '';
    return code || null;
  } catch {
    return null;
  }
}

function seedRosaStructuredPlan({ patientId, adminId, now }) {
  const aki = get("SELECT id, code_suggestion FROM problems WHERE patient_id=? AND label='acute kidney injury'", patientId);
  const cap = get("SELECT id, code_suggestion FROM problems WHERE patient_id=? AND label='community-acquired pneumonia'", patientId);
  const pulse = get("SELECT id, code_suggestion FROM problems WHERE patient_id=? AND label='Elevated Pulse'", patientId);
  // Store accepted codes on items so toggle-on shows them; include_icd starts false
  // so default A&P has no codes until the clinician enables the toggle.
  const structured = {
    version: 1,
    include_icd: false,
    items: [
      {
        problem_id: cap?.id || null,
        label: 'community-acquired pneumonia',
        assessment: 'Hospital day 3 for community-acquired pneumonia; cultures pending.',
        plan: 'Continue ceftriaxone and azithromycin; follow blood cultures.',
        code: acceptedCodeFromProblem(cap) || 'J18.9',
      },
      {
        problem_id: aki?.id || null,
        label: 'acute kidney injury',
        assessment: 'Creatinine increased from 0.9 to 2.1 mg/dL with low urine output.',
        plan: 'Hold nephrotoxins; recheck creatinine; assess volume status.',
        code: acceptedCodeFromProblem(aki) || 'N17.9',
      },
      {
        problem_id: pulse?.id || null,
        label: 'Elevated Pulse',
        assessment: 'Pulse 112 bpm with rising oxygen need after SpO2 88% on room air.',
        plan: 'Correlate with oxygen delivery and volume before attributing to fever alone.',
        // No code: insufficient specificity / not a billable diagnosis alone — flag when ICD on.
        code: acceptedCodeFromProblem(pulse),
      },
    ],
  };
  run(
    'INSERT INTO plans(id,patient_id,plan_date,text,author_id,revision,created_at) VALUES(?,?,?,?,?,?,?)',
    uid(),
    patientId,
    now.slice(0, 10),
    JSON.stringify(structured),
    adminId,
    1,
    now,
  );
}

/**
 * Idempotent: ensure Rosa fictional case exists on an already-seeded DB without wiping users.
 * Does not delete other patients' data.
 */
export async function ensureRosaDemoCase() {
  const team = get("SELECT id FROM teams WHERE name LIKE '%Team A%' LIMIT 1")
    || get('SELECT id FROM teams LIMIT 1');
  const admin = get("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!team || !admin) return null;
  const now = nowIso();
  let rosa = get("SELECT * FROM patients WHERE display_name LIKE 'Rosa Martinez%' LIMIT 1");
  if (!rosa) {
    const id = uid();
    run(
      'INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,revision,created_at) VALUES(?,?,?,?,?,?,?,1,?)',
      id, team.id, 'Rosa Martinez', '509A', '60s', 'female', 10, now,
    );
    rosa = get('SELECT * FROM patients WHERE id=?', id);
    ensurePatientChannel({ patient: rosa, createdBy: admin.id });
    await seedPatientFacts({ patientId: id, sources: ROSA_SOURCES, now });
  }
  const patientId = rosa.id;
  const ensureProblem = (label, codePayload) => {
    let row = get('SELECT * FROM problems WHERE patient_id=? AND label=?', patientId, label);
    if (!row) {
      run(
        `INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
        uid(), patientId, label, 'confirmed', '[]', '', now, now,
      );
      row = get('SELECT * FROM problems WHERE patient_id=? AND label=?', patientId, label);
    }
    if (codePayload && !row.code_suggestion) {
      run('UPDATE problems SET code_suggestion=? WHERE id=?', JSON.stringify(codePayload), row.id);
    }
    return row;
  };
  ensureProblem('acute kidney injury', {
    code: 'N17.9',
    description: 'Acute kidney failure, unspecified',
    billable: true,
    label: 'Suggestion for clinician/coder review. Not a billing determination.',
  });
  ensureProblem('Elevated Pulse', null);
  ensureProblem('community-acquired pneumonia', {
    code: 'J18.9',
    description: 'Pneumonia, unspecified organism',
    billable: true,
    label: 'Suggestion for clinician/coder review. Not a billing determination.',
  });
  const planDate = now.slice(0, 10);
  const existingPlan = get('SELECT id, text FROM plans WHERE patient_id=? AND plan_date=? ORDER BY created_at DESC LIMIT 1', patientId, planDate);
  if (!existingPlan || !String(existingPlan.text || '').includes('"version":1')) {
    seedRosaStructuredPlan({ patientId, adminId: admin.id, now });
  } else {
    // Backfill accepted ICD onto plan items without changing assessment/plan wording.
    try {
      const structured = JSON.parse(existingPlan.text);
      if (structured?.version === 1 && Array.isArray(structured.items)) {
        let dirty = false;
        for (const it of structured.items) {
          if (it.code) continue;
          const p = it.problem_id
            ? get('SELECT code_suggestion FROM problems WHERE id=?', it.problem_id)
            : get('SELECT code_suggestion FROM problems WHERE patient_id=? AND label=?', patientId, it.label);
          const code = acceptedCodeFromProblem(p);
          if (code) {
            it.code = code;
            dirty = true;
          }
        }
        if (dirty) {
          run('UPDATE plans SET text=? WHERE id=?', JSON.stringify(structured), existingPlan.id);
          console.log('Backfilled ICD codes onto Rosa structured plan items (wording unchanged).');
        }
      }
    } catch {
      /* leave existing plan */
    }
  }
  ensureDemoLearningBanks();
  ensureDemoApprovedCheckRules();
  // Safe cleanup only: reject identity facts / scrub John Doe lines under Rosa.
  purgeIdentityFacts();
  return { patientId };
}

function seedApprovedMcq({
  adminId, topic, vignette, question, options, correctIndex, explanations, now,
  learningObjective, evidence = [],
}) {
  const id = uid();
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const answer = letters[correctIndex] || 'A';
  const option_explanations = {};
  (explanations || []).forEach((text, i) => {
    if (i < letters.length && text) option_explanations[letters[i]] = text;
  });
  const content = {
    vignette,
    question,
    options,
    correct_index: correctIndex,
    answer,
    explanations,
    option_explanations,
    explanation: option_explanations[answer] || '',
    learning_objective: learningObjective
      || 'Connect the finding to documented chart facts without inventing unsupported diagnoses.',
    evidence,
    model: 'seed',
  };
  run(
    `INSERT INTO mcqs(id,topic,topic_key,difficulty,stage,content,validation,status,source,created_by,approved_by,approved_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    topic,
    topicKey(topic),
    'core',
    'application',
    JSON.stringify(content),
    JSON.stringify({ ok: true, seed: true }),
    'approved',
    'human',
    adminId,
    adminId,
    now,
    now,
  );
  return id;
}

async function seedPatientFacts({ patientId, sources, now }) {
  for (const s of sources) {
    const sid = uid();
    run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)', sid, patientId, s.kind, s.title, s.event_time, now, s.text);
    const { json } = await mockGenerate({ operation: 'extract_facts', payload: { source: { ...s, id: sid } } });
    const { output } = validateExtractFacts(json, { ...s, id: sid });
    for (const f of output.facts) {
      run(`INSERT INTO facts(id,patient_id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,revision,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,'confirmed',1,?)`, uid(), patientId, f.label, f.value, f.unit, f.event_time, sid, f.source_passage, f.assertion, now);
    }
  }
}

/**
 * Reject identity / demographics facts and scrub demo contamination (e.g. John Doe)
 * from fact labels, values, and source passages. Does not delete patients or users.
 */
export function purgeIdentityFacts() {
  const rows = all('SELECT id, label, value, source_passage FROM facts');
  let n = 0;
  for (const f of rows) {
    const passage = f.source_passage || '';
    const blob = `${f.label} ${f.value} ${passage}`;
    const contaminated = isIdentityFact(f.label, f.value)
      || isIdentityFact(f.label, passage)
      || /\bjohn\s*doe\b|\bjane\s*doe\b/i.test(blob)
      || (/visit|admit|encounter/i.test(f.label) && /\b2023\b/.test(String(f.value || '')))
      || /\bvisit\s*date\b/i.test(f.label) && /\b2023\b/.test(blob);
    if (contaminated) {
      // Remove from demo charts entirely so identity leakage cannot reappear in any status filter.
      run('DELETE FROM facts WHERE id=?', f.id);
      n += 1;
    }
  }
  // Scrub identity header lines from source text without deleting the clinical remainder.
  const sources = all('SELECT id, text FROM sources');
  for (const s of sources) {
    const text = String(s.text || '');
    if (!/\b(patient\s*name|john\s*doe|jane\s*doe|visit\s*date)\b/i.test(text)) continue;
    const cleaned = text
      .split(/\r?\n/)
      .filter((line) => !/\b(patient\s*name\s*:|john\s*doe|jane\s*doe|visit\s*date\s*:)/i.test(line))
      .join('\n')
      .replace(/\bPatient Name:\s*John Doe\.?\s*/gi, '')
      .replace(/\bVisit Date:\s*2023[^\n.]*/gi, '')
      .replace(/\bVisit Date:\s*\d{4}(-\d{2}(-\d{2})?)?[^\n.]*/gi, (m) => (/\b2023\b/.test(m) ? '' : m))
      .trim();
    if (cleaned !== text.trim()) {
      run('UPDATE sources SET text=? WHERE id=?', cleaned, s.id);
      n += 1;
    }
  }
  return n;
}

/**
 * All data here is fictional. Never put real patient data into a development database.
 * If a prior demo DB is contaminated (wrong-patient facts), delete the SQLite file and re-run seed.
 */
export async function seedDemo() {
  seedTemplates();
  seedDemoIcdIfEmpty();
  seedExampleCheckRules();
  ensureDemoApprovedCheckRules();
  // Existing DBs: drop identity leakage, backfill learning, ensure Rosa demo case.
  if (get('SELECT 1 AS x FROM users LIMIT 1')) {
    const purged = purgeIdentityFacts();
    if (purged) console.log(`Purged ${purged} identity fact(s) / scrubbed source line(s) from existing demo DB.`);
    // Drop demo curated reads that used fictional example.com URLs (not verified PubMed).
    run("DELETE FROM curated_reads WHERE url LIKE '%example.com%' OR citation LIKE '%fictional citation%'");
    // UI should show clean names — strip old seed " (fictional)" suffix.
    run(`UPDATE patients SET display_name = TRIM(REPLACE(display_name, ' (fictional)', ''))
         WHERE display_name LIKE '% (fictional)'`);
    ensureDemoLearningBanks();
    ensureDemoApprovedCheckRules();
    await ensureRosaDemoCase();
    return null;
  }
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
  const alexId = uid();
  run('INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,revision,created_at) VALUES(?,?,?,?,?,?,?,1,?)', patientId, teamA, 'Rosa Martinez', '509A', '60s', 'female', 10, now);
  run('INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,revision,created_at) VALUES(?,?,?,?,?,?,?,1,?)', alexId, teamA, 'Alex Rivera', '401', '50s', 'male', 20, now);
  ensureTeamChannel({ teamId: teamA, createdBy: admin });
  ensureTeamChannel({ teamId: teamB, createdBy: other });
  ensurePatientChannel({ patient: get('SELECT * FROM patients WHERE id=?', patientId), createdBy: admin });
  ensurePatientChannel({ patient: get('SELECT * FROM patients WHERE id=?', alexId), createdBy: admin });

  await seedPatientFacts({ patientId, sources: ROSA_SOURCES, now });
  await seedPatientFacts({ patientId: alexId, sources: ALEX_SOURCES, now });

  // Confirmed problems drive Learn topics for the demo.
  const rosaFacts = get("SELECT id FROM facts WHERE patient_id=? AND label LIKE '%Creatinine%' ORDER BY created_at DESC LIMIT 1", patientId);
  const insertProblem = (label, factIds) => run(
    `INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    uid(), patientId, label, 'confirmed', JSON.stringify(factIds), '', now, now,
  );
  insertProblem('acute kidney injury', rosaFacts ? [rosaFacts.id] : []);
  insertProblem('Elevated Pulse', []);
  insertProblem('community-acquired pneumonia', []);

  // Seed accepted ICD examples so the A&P ICD toggle can be demonstrated.
  const akiProblem = get("SELECT id FROM problems WHERE patient_id=? AND label='acute kidney injury'", patientId);
  const capProblem = get("SELECT id FROM problems WHERE patient_id=? AND label='community-acquired pneumonia'", patientId);
  if (akiProblem) {
    run(
      'UPDATE problems SET code_suggestion=? WHERE id=?',
      JSON.stringify({
        code: 'N17.9',
        description: 'Acute kidney failure, unspecified',
        billable: true,
        label: 'Suggestion for clinician/coder review. Not a billing determination.',
      }),
      akiProblem.id,
    );
  }
  if (capProblem) {
    run(
      'UPDATE problems SET code_suggestion=? WHERE id=?',
      JSON.stringify({
        code: 'J18.9',
        description: 'Pneumonia, unspecified organism',
        billable: true,
        label: 'Suggestion for clinician/coder review. Not a billing determination.',
      }),
      capProblem.id,
    );
  }

  seedRosaStructuredPlan({ patientId, adminId: admin, now });

  for (const topic of Object.keys(DEMO_TOPIC_BANKS)) {
    ensureTopicBankDepth(topic, { adminId: admin, now, min: 5 });
  }
  ensureElevatedPulseCuratedReads(admin);
  ensureDemoApprovedCheckRules();

  // Intentionally no fictional PubMed / example.com curated reads.
  // Learning evidence must come from validated PubMed retrieval or admin-approved real citations.

  return { teamA, teamB, admin, resident, other, patientId, alexId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openDb(config.dbPath);
  const out = await seedDemo();
  console.log(out ? `Seeded demo data.\n  admin@rounds.test / resident@rounds.test / other@rounds.test\n  password: ${DEMO_PASSWORD}\n  Tip: delete the SQLite DB file and re-run seed if a prior demo was contaminated.` : 'Database already has users; nothing seeded.');
}
