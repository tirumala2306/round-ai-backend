// Deterministic offline provider. It is NOT clinical AI: it only reshuffles the facts it is given so that
// the API, validators, and the mobile/admin UI can be built and tested without any external service.

const claim = (text, fact_ids) => ({ text, fact_ids, label: 'From chart' });
const fmt = (f) => `${f.label}: ${f.value}${f.unit ? ' ' + f.unit : ''}${f.assertion === 'negated' ? ' (negated)' : f.assertion === 'uncertain' ? ' (uncertain)' : ''}`;
const day = (f) => (f.event_time || 'Unknown').slice(0, 10);

function splitSentences(text) {
  return text.split(/(?<=\S)\.(?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
}

const ops = {
  extract_facts({ source }) {
    const facts = [];
    for (const sentence of splitSentences(source.text)) {
      const passage = sentence;
      const lower = sentence.toLowerCase();
      const assertion = /^(no|denies|without)\b/.test(lower) ? 'negated'
        : /\b(possible|suspected|likely|rule out|r\/o|probable)\b/.test(lower) ? 'uncertain' : 'present';
      const m = sentence.match(/([A-Za-z][A-Za-z0-9 ]{1,30}?)\s+(\d+(?:\.\d+)?)\s*(mg\/dL|mmol\/L|mL\/hr|mmHg|bpm|g\/dL|%|C|L)?/);
      if (m && m[3] !== undefined) {
        facts.push({ label: m[1].trim(), value: m[2], unit: m[3], event_time: source.event_time || null, assertion, source_passage: passage });
      } else {
        facts.push({ label: 'Observation', value: sentence, unit: '', event_time: source.event_time || null, assertion, source_passage: passage });
      }
    }
    return { facts };
  },

  summarize_patient({ context }) {
    const f = context.facts;
    const pick = (re) => f.filter((x) => re.test(`${x.label} ${x.value}`.toLowerCase()));
    const sec = (key, title, list) => ({ key, title, claims: list.map((x) => claim(`${day(x)} ${fmt(x)}`, [x.fact_id])) });
    const lastByLabel = new Map();
    for (const x of f) if (/^-?\d/.test(x.value)) lastByLabel.set(x.label.toLowerCase(), x);
    const trendClaims = context.trends.map((t) => claim(`${t.label} ${t.direction} from ${t.from.value} to ${t.to.value} ${t.unit}`.trim(), [t.from.fact_id, t.to.fact_id]));
    const first = f[0];
    return {
      one_liner: first ? claim(String(first.label === 'Observation' ? first.value : fmt(first)).slice(0, 200), [first.fact_id]) : null,
      sections: [
        sec('reason_for_admission', 'Reason for admission', pick(/admitted/).slice(0, 2)),
        { key: 'brief_course', title: 'Brief course', claims: [...trendClaims, ...f.slice(-4).map((x) => claim(`${day(x)} ${fmt(x)}`, [x.fact_id]))] },
        sec('active_problems', 'Active problems', pick(/possible|suspected|likely/).slice(0, 4)),
        sec('key_findings', 'Key findings', [...lastByLabel.values()].slice(0, 6)),
        sec('pending_work', 'Pending work', pick(/pending|awaiting|ordered/).slice(0, 4)),
      ].filter((s) => s.claims.length),
      missing_information: [],
      conflicts: [],
    };
  },

  draft_note({ context, template, inputs }) {
    const sections = template.sections.map((s) => {
      let text = '';
      let ids = [];
      if (s.source === 'clinician_history') text = inputs.history?.[s.key] || '';
      else if (s.source === 'clinician_subjective') text = inputs.subjective || '';
      else if (s.source === 'clinician_exam') text = inputs.exam || '';
      else if (s.source === 'clinician_update') text = inputs.update || '';
      else if (s.source === 'clinician_support') text = inputs.support || '';
      else if (s.source === 'clinician_plan') text = inputs.plan || '';
      else if (s.source === 'facts' || s.source === 'facts_and_exam') {
        const recent = context.facts.slice(-8);
        ids = recent.map((x) => x.fact_id);
        text = [s.source === 'facts_and_exam' ? inputs.exam : '', ...recent.map((x) => `${day(x)} ${fmt(x)}`)].filter(Boolean).join('\n');
      }
      return { key: s.key, text, fact_ids: ids };
    });
    return { sections, missing_information: [], proposed_considerations: [] };
  },

  rewrite_section({ text, mode }) {
    const t = String(text || '').trim();
    if (mode === 'shorten') return { text: t.split(/(?<=\.)\s+/).slice(0, 2).join(' ') };
    return { text: t };
  },

  suggest_problems({ context, rejected_labels }) {
    const rej = new Set((rejected_labels || []).map((x) => x.toLowerCase()));
    const out = [];
    for (const f of context.facts) {
      const v = String(f.value);
      let m = v.match(/admitted with ([a-zA-Z\- ]+)/i);
      if (m) out.push({ label: m[1].trim().toLowerCase(), state: 'Documented in source', fact_ids: [f.fact_id], uncertainty: '' });
      m = v.match(/(?:possible|suspected|probable|likely) ([a-zA-Z\- ]+)/i);
      if (m) out.push({ label: m[1].trim().toLowerCase(), state: 'Suggested by AI', fact_ids: [f.fact_id], uncertainty: 'Documented as uncertain in the source.' });
    }
    const seen = new Set();
    return { problems: out.filter((p) => !rej.has(p.label) && !seen.has(p.label) && seen.add(p.label)) };
  },

  explain_evidence({ studies }) {
    return {
      items: studies.map((s) => ({
        evidence_id: s.evidence_id,
        what_found: s.abstract ? s.abstract.split(/(?<=\.)\s+/).slice(-2).join(' ') : '',
        applicability: { resembles: [], differs: [], unknown: ['Applicability was not assessed in mock mode. Compare the study population with your patient.'] },
        discuss: 'Review the full paper before applying to this patient.',
      })),
    };
  },

  generate_mcq({ topic, stage, evidence_packet }) {
    return {
      vignette: `[MOCK CONTENT, connect a real AI provider] A fictional patient is being evaluated for ${topic}.`,
      question: `Which of the following is the best next consideration at the "${stage}" stage?`,
      options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D', E: 'Option E' },
      answer: 'C',
      explanation: 'Mock explanation. Replace by running with AI_PROVIDER=openai.',
      option_explanations: { A: 'Mock', B: 'Mock', C: 'Mock (correct)', D: 'Mock', E: 'Mock' },
      learning_objective: `Reason about ${topic} (${stage}).`,
      references: evidence_packet.slice(0, 1).map((e) => ({ pmid: e.pmid })),
    };
  },

  validate_mcq() {
    return { one_defensible_answer: true, ambiguous: false, unsupported_claims: [], issues: [] };
  },

  extract_tasks({ plan_text }) {
    const tasks = [];
    for (const raw of plan_text.split(/\n|;/).map((s) => s.trim()).filter(Boolean)) {
      const quote = raw;
      const owner = (raw.match(/\[owner:\s*([^\]]+)\]/i) || [])[1] || null;
      const due = (raw.match(/\[due:\s*([^\]]+)\]/i) || [])[1] || null;
      const text = raw.replace(/\[(owner|due):[^\]]*\]/gi, '').replace(/^[-*\d.\s]+/, '').trim();
      if (text) tasks.push({ text, owner, due, plan_quote: quote });
    }
    return { tasks };
  },

  answer_chart_question({ context, question }) {
    const words = new Set(question.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const scored = context.facts
      .map((f) => ({ f, s: `${f.label} ${f.value}`.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
      .sort((a, b) => b.s - a.s || (b.f.event_time || '').localeCompare(a.f.event_time || ''));
    const top = scored.filter((x) => x.s > 0).slice(0, 4);
    const use = top.length ? top : scored.slice(0, 3);
    return {
      answer: use.map((x) => claim(`${day(x.f)} ${fmt(x.f)}`, [x.f.fact_id])),
      missing_information: top.length ? [] : ['No chart fact directly matched the question; showing the most recent facts.'],
    };
  },

  draft_signout({ context }) {
    const f = context.facts;
    return {
      summary: f.slice(-5).map((x) => claim(`${day(x)} ${fmt(x)}`, [x.fact_id])),
      outstanding_actions: f.filter((x) => /pending|awaiting|ordered/i.test(x.value)).map((x) => claim(`${fmt(x)}`, [x.fact_id])),
      missing_information: [],
    };
  },

  explore_considerations() {
    return { considerations: [] };
  },

  summarize_chat_thread({ messages }) {
    const use = (messages || []).slice(-5);
    return {
      bullets: use.map((m) => ({
        text: `[MOCK] ${String(m.body || '').slice(0, 120)}`,
        message_ids: [m.message_id || m.id],
      })),
      open_questions: [],
      missing_information: use.length ? [] : ['No messages in thread'],
    };
  },

  present_patient({ context, changes, clinician_plan }) {
    const facts = context?.facts || [];
    const use = (changes?.new_facts?.length ? changes.new_facts : facts.slice(-8));
    const sentences = use.map((f) => ({
      text: `${(f.event_time || '').slice(0, 10) || 'Recently'} ${f.label}: ${f.value}${f.unit ? ' ' + f.unit : ''}${f.assertion === 'negated' ? ' (negated)' : f.assertion === 'uncertain' ? ' (uncertain)' : ''}.`,
      fact_ids: [f.fact_id],
    }));
    // Pad toward the spoken word budget with additional cited restatements (still fact-backed).
    const wordsSoFar = () => sentences.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    let guard = 0;
    while (wordsSoFar() < 150 && facts.length && guard < 40) {
      const f = facts[guard % facts.length];
      sentences.push({
        text: `Also noted, ${f.label} was ${f.value}${f.unit ? ' ' + f.unit : ''} on ${(f.event_time || '').slice(0, 10) || 'an unspecified date'}.`,
        fact_ids: [f.fact_id],
      });
      guard += 1;
    }
    const plan_sentences = clinician_plan?.text
      ? [{ text: `Plan today: ${String(clinician_plan.text).split(/\n/)[0].slice(0, 200)}.` }]
      : [];
    return { sentences, plan_sentences, missing_information: clinician_plan?.text ? [] : ['clinician_plan'] };
  },

  draft_check_rule({ condition }) {
    const c = String(condition || 'condition').trim() || 'condition';
    const lower = c.toLowerCase();
    if (/pyelo|kidney infection/i.test(lower)) {
      return {
        name: `Pyelonephritis checks for ${c}`,
        match: { problem_keywords: ['pyelonephritis', 'pyelo'], icd_prefixes: ['N10'] },
        prompts: [{ text: 'Check CVA tenderness', kind: 'exam' }],
        compare: null,
      };
    }
    if (/stroke|cva|infarct/i.test(lower)) {
      return {
        name: `Stroke neuro compare for ${c}`,
        match: { problem_keywords: ['stroke', 'cva'], icd_prefixes: ['I63'] },
        prompts: [{ text: 'Re-examine neurological deficits vs yesterday', kind: 'exam' }],
        compare: { fact_label_keywords: ['neuro', 'motor', 'speech', 'weakness'], lookback_days: 1 },
      };
    }
    return {
      name: `Reminders for ${c}`,
      match: { problem_keywords: [lower.slice(0, 40)], icd_prefixes: [] },
      prompts: [{ text: `Review key exam and labs related to ${c}`, kind: 'review' }],
      compare: null,
    };
  },

  suggest_icd({ problem, candidates, context }) {
    const list = Array.isArray(candidates) ? candidates : [];
    const pick = list[0];
    if (!pick) return { suggestions: [], reviewer_notes: ['No local ICD candidates matched this problem label.'] };
    const facts = (context?.facts || []).slice(0, 3).map((f) => f.fact_id);
    const uncertain = /\b(possible|suspected|probable|likely|rule out)\b/i.test(`${problem?.label || ''} ${problem?.uncertainty || ''}`)
      || problem?.state === 'differential';
    return {
      suggestions: [
        {
          code: pick.code,
          fact_ids: facts,
          missing_for_specificity: uncertain
            ? ['Clarify whether this diagnosis is confirmed', 'Document laterality / acuity / type if applicable']
            : ['Organism or etiology if known', 'Laterality / acuity / episode of care if applicable'],
          rationale: `Best lexical match among local candidates for "${problem?.label || ''}".`,
        },
        // Bogus code: validator must drop anything not in the local candidate list (mock-only trap).
        { code: 'ZZ99.99', fact_ids: facts, missing_for_specificity: [], rationale: 'not a real candidate' },
      ],
      reviewer_notes: uncertain ? ['Mock: uncertain problem — not a confirmed code.'] : [],
    };
  },

  propose_census({ source_text }) {
    const text = String(source_text || '');
    const patients = [];
    for (const raw of text.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
      if (!raw.includes('|')) continue;
      const parts = raw.split('|').map((s) => s.trim());
      if (parts.length < 2) continue;
      patients.push({
        display_name: parts[1],
        room: parts[0] || '',
        age_band: parts[2] || '',
        sex: parts[3] || '',
        one_line_reason: parts[4] || '',
        source_text: raw,
      });
    }
    if (!patients.length) {
      // Spoken / free-text fallback used by mock audio → still cites substrings of the extract.
      const reason = (text.match(/productive cough[^.]*/i) || ['productive cough'])[0];
      const aki = (text.match(/Creatinine[^.]*/i) || ['Creatinine'])[0];
      patients.push(
        { display_name: 'Alex Rivera (fictional)', room: '401', age_band: '50s', sex: 'male', one_line_reason: reason.slice(0, 120), source_text: reason.slice(0, 200) },
        { display_name: 'Jordan Lee (fictional)', room: '402', age_band: '40s', sex: 'female', one_line_reason: aki.slice(0, 120), source_text: aki.slice(0, 200) },
      );
    }
    return { patients };
  },
};

export async function mockGenerate({ operation, payload }) {
  const fn = ops[operation];
  if (!fn) throw new Error(`mock: unknown operation ${operation}`);
  return { json: fn(payload), model: 'mock-1', usage: { input_tokens: 0, output_tokens: 0 } };
}

/** Offline speech-to-text. Ignores audio bytes; returns a fixed clinical dictation. */
export async function mockTranscribe() {
  return {
    json: {
      text: 'Patient reports productive cough for three days. Creatinine 2.1 mg/dL this morning. Blood cultures pending.',
    },
    model: 'mock-transcribe-1',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Offline vision OCR. If the caller embeds the sentinel "LOW_LEGIBILITY" in the
 * base64 string (tests), a line is marked low-legibility; otherwise all lines are ok.
 */
export async function mockExtractFromImage({ imageBase64 }) {
  let decoded = '';
  try { decoded = Buffer.from(String(imageBase64 || ''), 'base64').toString('utf8'); } catch { /* ignore */ }
  const marker = decoded.includes('LOW_LEGIBILITY') || String(imageBase64 || '').includes('LOW_LEGIBILITY');
  if (decoded.includes('CENSUS') || String(imageBase64 || '').includes('CENSUS')) {
    const text = [
      '401 | Alex Rivera (fictional) | 50s | male | community-acquired pneumonia',
      '509A | Rosa Martinez (fictional) | 60s | female | possible acute kidney injury',
    ].join('\n');
    return {
      json: { text, lines: text.split('\n').map((t) => ({ text: t, legibility: 'ok' })), low_legibility_lines: [], confidence: 'ok' },
      model: 'mock-vision-1',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  const lines = [
    { text: 'Handwritten progress note.', legibility: 'ok' },
    { text: 'Creatinine 2.4 mg/dL.', legibility: 'ok' },
    { text: marker ? 'BP reading illegible on photocopy.' : 'Blood pressure 128/78 mmHg.', legibility: marker ? 'low' : 'ok' },
  ];
  const low = lines.filter((l) => l.legibility === 'low').map((l) => l.text);
  // Source text includes every line so the clinician can still see what was attempted;
  // low-legibility lines are listed separately and must not become facts.
  return {
    json: {
      text: lines.map((l) => l.text).join(' '),
      lines,
      low_legibility_lines: low,
      confidence: marker ? 'partial' : 'ok',
    },
    model: 'mock-vision-1',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
