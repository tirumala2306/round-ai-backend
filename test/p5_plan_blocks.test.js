process.env.DB_PATH = ':memory:';
process.env.AI_PROVIDER = 'mock';
process.env.AUTH_SECRET = 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parsePlanRecord,
  renderPlanText,
  acceptedCodeFromSuggestion,
  buildStructuredFromBody,
} = await import('../src/plan.js');

test('P5: plain text migrates to one General block', () => {
  const parsed = parsePlanRecord({ text: 'Continue IVF. Recheck Cr AM.' });
  assert.equal(parsed.migrated_from_plain, true);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].label, 'General');
  assert.equal(parsed.items[0].plan, 'Continue IVF. Recheck Cr AM.');
  assert.equal(parsed.items[0].manually_edited, true);
  assert.ok(parsed.structured);
});

test('P5: acceptedCodeFromSuggestion ignores unreviewed suggestions', () => {
  assert.equal(
    acceptedCodeFromSuggestion({ code: 'N17.9', rationale: 'likely' }),
    null,
  );
  assert.equal(
    acceptedCodeFromSuggestion({
      code: 'n17.9',
      accepted_at: '2026-11-24T00:00:00Z',
    }),
    'N17.9',
  );
  assert.equal(
    acceptedCodeFromSuggestion({
      code: 'J18.9',
      coding_status: 'accepted',
    }),
    'J18.9',
  );
});

test('P5: renderPlanText with include_icd uses accepted codes only', () => {
  const structured = {
    version: 1,
    include_icd: true,
    items: [
      { label: 'AKI', assessment: 'Cr up', plan: 'IVF', problem_id: 'p1' },
      { label: 'CAP', assessment: 'fever', plan: 'abx', problem_id: 'p2' },
    ],
  };
  const problems = [
    {
      id: 'p1',
      label: 'AKI',
      code_suggestion: { code: 'N17.9', accepted_at: '2026-11-01' },
    },
    {
      id: 'p2',
      label: 'CAP',
      code_suggestion: { code: 'J18.9', rationale: 'possible' },
    },
  ];
  const text = renderPlanText(structured, { problems });
  assert.match(text, /AKI \(N17\.9\)/);
  assert.match(text, /^CAP$/m);
  assert.doesNotMatch(text, /J18\.9/);
});

test('P5: buildStructuredFromBody clears codes when ICD toggle off', () => {
  const built = buildStructuredFromBody({
    include_icd: false,
    items: [
      { label: 'AKI', plan: 'IVF', code: 'N17.9' },
    ],
  });
  assert.equal(built.structured.include_icd, false);
  assert.equal(built.structured.items[0].code, null);
});
