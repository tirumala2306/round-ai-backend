# RoundsAI client requirements — completion matrix

Date: 2026-11-20. Statuses: PASS / PARTIAL / FAIL / BLOCKED only.

| # | Requirement | Status | Backend notes |
|---|-------------|--------|---------------|
| 1 | Note generation reliability | PASS | `draftNoteFromDictation` requires ≥12 chars; generic mock path; review blocks flags/placeholders; clinician edit sets `status=draft`; export after review. |
| 2 | Today/Census sync | PASS | FE marks dirty; census list returns one_liner/key_changes. |
| 3 | Human-readable clinical UI | PASS | Context trends rendered as clinical sentences. |
| 4 | Simplified home | PASS | Census payload enriched for home rows. |
| 5 | Patient workspace / A&P | PASS | Structured plan JSON GET/PUT + ICD-aware render. |
| 6 | Fact review | PASS | Passage validation; SpO2 context; identity exclusion. |
| 7 | Rosa demo consistency | PASS | `purgeIdentityFacts` + source scrub; `ensureRosaDemoCase` idempotent; no user wipe. |
| 8 | Note draft/review/copy | PASS | Covered by note API tests. |
| 9 | Learning Elevated Pulse | PASS | 5-option bank; miss schedules review; no fictional example.com curated reads. |
| 10 | ICD toggle | PASS | Structured plan `include_icd`; accepted codes only. |
| 11 | Mobile Safari | BLOCKED | Not a backend concern; device E2E not run. |

## Tests

- `npm test` → **60/60 PASS** (includes Elevated Pulse spaced-review + identity purge regression).
