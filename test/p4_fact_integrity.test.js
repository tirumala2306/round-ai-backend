process.env.DB_PATH = ':memory:';
process.env.AI_PROVIDER = 'mock';
process.env.AUTH_SECRET = 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  validateExtractFacts,
  detectIdentityMismatch,
  dateWarningForFact,
  validatePlanProposals,
  extractQualifier,
} = await import('../src/ai/validators.js');

test('P4: qualifier must appear in passage or is dropped', () => {
  const source = {
    text: 'SpO2 88% on room air this morning.',
    event_time: '2026-11-24T06:00',
  };
  const ok = validateExtractFacts({
    facts: [{
      label: 'SpO2',
      value: '88',
      unit: '%',
      qualifier: 'on room air',
      assertion: 'present',
      source_passage: 'SpO2 88% on room air this morning.',
    }],
  }, source);
  assert.equal(ok.output.facts[0].qualifier, 'on room air');

  const bad = validateExtractFacts({
    facts: [{
      label: 'SpO2',
      value: '88',
      unit: '%',
      qualifier: 'on 6 L NC',
      assertion: 'present',
      source_passage: 'SpO2 88% on room air this morning.',
    }],
  }, source);
  assert.ok(bad.issues.some((i) => i.code === 'qualifier_not_in_passage'));
  // Invented qualifier dropped; passage-derived O₂ context kept.
  assert.equal(bad.output.facts[0].qualifier, 'on room air');
});

test('P4: extractQualifier pulls O2 context from passage', () => {
  const q = extractQualifier('', 'SpO2 88% on 2 L nasal cannula', 'SpO2', '88');
  assert.match(q, /2\s*L/i);
});

test('P4: identity mismatch when Patient Name differs from chart', () => {
  const hit = detectIdentityMismatch(
    'Patient Name: John Doe\nVisit Date: 2023-01-01\nCreatinine 2.1',
    'Rosa Martinez',
  );
  assert.ok(hit);
  assert.equal(hit.code, 'identity_mismatch');
  assert.match(hit.message, /John Doe/);

  const same = detectIdentityMismatch(
    'Patient Name: Rosa Martinez\nCreatinine 2.1',
    'Rosa Martinez (fictional)',
  );
  assert.equal(same, null);
});

test('P4: implausible / before-admission date warnings', () => {
  const far = dateWarningForFact('2020-01-15T08:00', { todayIso: '2026-11-24' });
  assert.ok(far);
  assert.equal(far.code, 'implausible_date');

  const before = dateWarningForFact('2026-08-20T08:00', {
    todayIso: '2026-11-24',
    admissionIso: '2026-08-29T08:00',
  });
  assert.ok(before);
  assert.equal(before.code, 'before_admission');

  const ok = dateWarningForFact('2026-11-23T08:00', { todayIso: '2026-11-24' });
  assert.equal(ok, null);
});

test('P4: plan proposals require transcript span in source', () => {
  const source = 'Assessment and plan: continue IVF and recheck creatinine in the morning.';
  const { proposals, issues } = validatePlanProposals({
    plan_proposals: [{
      title: 'Acute kidney injury',
      plan_text: 'continue IVF and recheck creatinine in the morning',
      transcript_span: 'continue IVF and recheck creatinine in the morning',
    }],
  }, source, [{ id: 'p1', label: 'Acute kidney injury', state: 'confirmed' }]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].problem_id, 'p1');
  assert.equal(proposals[0].source, 'dictation_proposal');

  const bad = validatePlanProposals({
    plan_proposals: [{
      title: 'AKI',
      plan_text: 'start dialysis tonight',
      transcript_span: 'start dialysis tonight',
    }],
  }, source, []);
  assert.equal(bad.proposals.length, 0);
  assert.ok(bad.issues.some((i) => i.code === 'plan_proposal_not_in_source'));
});

test('P4: validateExtractFacts surfaces identity warning + plan proposals together', () => {
  const source = {
    text: 'Patient Name: John Doe\nSpO2 93% on room air. Plan: continue ceftriaxone.',
    event_time: '2026-11-24T06:00',
  };
  const { output } = validateExtractFacts({
    facts: [{
      label: 'SpO2',
      value: '93',
      unit: '%',
      assertion: 'present',
      source_passage: 'SpO2 93% on room air.',
    }],
    plan_proposals: [{
      title: 'Pneumonia',
      plan_text: 'continue ceftriaxone',
      transcript_span: 'continue ceftriaxone',
    }],
  }, source, { patientDisplayName: 'Rosa Martinez', todayIso: '2026-11-24' });
  assert.ok(output.warnings.some((w) => w.code === 'identity_mismatch'));
  assert.equal(output.plan_proposals.length, 1);
  assert.equal(output.facts[0].qualifier, 'on room air');
});
