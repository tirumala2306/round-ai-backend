# RoundsAI Backend

Backend for the RoundsAI inpatient-rounds app: patient context, AI orchestration with code-level validation,
PubMed evidence, MCQ learning engine, and the admin-panel APIs.

- Needs **Node.js 22.13+** (built-in `node:sqlite` and `fetch`).
- **One justified npm dependency:** `busboy` — multipart parsing for audio/image intake. Prefer base64 JSON when the client already has bytes in memory.
- **Runs offline** with `AI_PROVIDER=mock` (placeholder AI, including mock transcription and vision OCR).
- **Fictional data only.** Do not load real patient data until your organization has approved the vendor, agreement and workflow.

## Quick start

```bash
cp .env.example .env        # then edit AUTH_SECRET
npm install                 # installs busboy
npm run seed                # demo users + one fictional patient
npm start                   # http://localhost:8080
npm test                    # end-to-end tests
```

Demo logins (password `ChangeMe-12345`): `admin@rounds.test`, `resident@rounds.test` (Team A, has the demo patient), `other@rounds.test` (Team B, cannot see Team A patients).

## Switching to a real AI model

```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...        # API account, not a ChatGPT login
OPENAI_MODEL=<model your organization approved>   # check current OpenAI docs for names
OPENAI_TRANSCRIBE_MODEL=<org-approved STT model>  # e.g. gpt-transcribe (required for audio)
OPENAI_VISION_MODEL=<org-approved vision model>   # optional; falls back to OPENAI_MODEL
```

`src/ai/adapter.js` calls the OpenAI Responses API with `store:false` for text ops, `/v1/audio/transcriptions` for speech-to-text,
and Responses `input_image` for vision OCR. Contracts: `generate`, `transcribe({audioBase64, mimeType})`,
`extractFromImage({imageBase64, mimeType})`. Run one real call per operation and inspect `validation_issues`.

## Architecture

```
Flutter app / Admin panel  ->  HTTP API (src/routes)
                                  |
                         AI orchestrator (src/ai/orchestrator.js)
              context builder -> prompt -> provider adapter -> VALIDATORS -> artifact (draft)
                                  |                |
                         SQLite (source of truth)  PubMed E-utilities (src/evidence)
```

Key rules enforced **in code**, not by prompts:

| Rule | Where |
|---|---|
| Only clinician-confirmed facts reach the model; no name/room sent | `context.js` |
| Every claim must cite known `fact_id`s; invented numbers are dropped | `validators.js` |
| Extracted facts must quote the source verbatim | `validateExtractFacts` |
| Differences/trends/conflicts computed in code, not by the model | `context.js` |
| Plan, exam, subjective come only from what the clinician typed (placeholder otherwise) | `validateNote` |
| Review blocked while flagged/placeholder sections remain, or if the chart changed (Outdated) | `routes/patients.js` |
| AI problem suggestions are never "confirmed"; rejected labels never come back | `orchestrator.js` |
| Evidence only from PubMed; retracted/editorial excluded; URL built from PMID; numbers must be in abstract | `pubmed.js`, `validateEvidenceExplain` |
| Evidence query rejects patient identifiers | `assertQuerySafe` |
| MCQ: 5 options, one key, every option explained, second validation pass, withheld if it fails | `validateMcq`, `generateMcqs` |
| Learner history is topic-level only (no patient link) | `attempts` table |
| Sign-out contingencies only from the clinician | `validateSignout` |
| Team isolation, audit log (IDs/codes only), kill switch, per-user daily cap, idempotency keys | `auth.js`, `db.js`, `orchestrator.js`, `routes/ai.js` |

## API map

Auth header: `Authorization: Bearer <token>`. AI endpoints accept an `Idempotency-Key` header.
Every AI response is an envelope: `artifact_id, operation, patient_id, context_revision, status (draft|partial), review_state, outdated, requires_review, provider, model, prompt_version, usage, generation_ms, content`.

**Auth / me:** `POST /auth/login`, `GET /me`, `GET /templates` (`admit_hp`, `progress`, `icu`), `GET /health`

**Census & patient:** `GET /patients` (ordered by `sort_order` then room), `POST /patients`, `PATCH /patients/:id` (`sort_order`, `room`, `display_name`), `GET /patients/:id`, `GET /patients/:id/changes`,
`POST /census/intake` (photo/voice → **proposed** patients only), `POST /census/intake/:id/confirm` `{items:[{index, edits?, skip?}]}` (creates patients + pending reason fact),
`GET /census/export?team_id=` (JSON + plain-text printable list; never AI-ranked)

**Chart data:** `POST/GET /patients/:id/sources`, `GET /patients/:id/facts?status=`, `POST /patients/:id/facts` (manual, confirmed),
`POST /patients/:id/facts/review` `{fact_ids, status}`, `GET /facts/:id/source` (source drawer), `PUT /patients/:id/plan`

**AI:** `POST /patients/:id/sources/:sid/extract`, `/summary`, `/present` (M3b oral presentation), `/notes`, `/problems/suggest`, `/evidence`, `/mcq`, `/tasks/propose`, `/signout`, `/ask`, `/considerations` (off by default),
`POST /artifacts/:id/sections/:key/rewrite` `{mode: regenerate|shorten|expand|improve}` (returns before/after, applies nothing)

**Oral presentation (M3b):** `POST /patients/:id/present` `{date?}` — ~60–90s spoken draft (~150–220 words) from confirmed facts, `changesSince()`, latest reviewed summary, and clinician plan. Every chart sentence cites `fact_ids`; unsupported sentences dropped; over-budget flagged. Always `requires_review`.

**Scribe intake (M2a):** `POST /patients/:id/intake` (multipart or JSON base64; `kind=audio|image`) → `{source_id, transcript_or_text, fact_ids, low_legibility_lines, confidence, artifact}`;
`POST /transcribe` (audio → text only, for note field dictation). Raw uploads are PHI: processed in memory and discarded unless `RETAIN_RAW_UPLOADS=true`. MIME allow-lists and size caps apply (defaults: audio 25 MiB, image 10 MiB). Extracted facts still go through `validateExtractFacts` (verbatim passage). Low-legibility image lines become `missing_information`, not facts.

**Artifacts:** `GET /patients/:id/artifacts`, `GET /artifacts/:id`, `PATCH /artifacts/:id` (edit note sections), `POST /artifacts/:id/review`, `GET /artifacts/:id/export` (clean text, reviewed only), `GET /artifacts/:id/versions`

**Problems & tasks:** `GET /patients/:id/problems`, `POST /patients/:id/problems/:pid/decision` `{action: accept|differential|reject}`, `GET/POST /patients/:id/tasks`, `POST /tasks/:id/accept|dismiss|complete`

**Learning:** `POST /learning/generate`, `GET /mcq/:id` (no answer; approved or unreviewed-by-id only), `POST /mcq/:id/answer`, `POST /mcq/:id/report`, `GET /learning/review-queue`, `GET /learning/stats`, `GET/POST /reading-list`

**Teaching (M4):** `GET /teaching/plan?date=` — census topics from confirmed/differential problems (generic strings + counts; no patient ids stored).
`GET /teaching/questions?topic=&count=&allow_generate=` — **approved bank first** (spaced-review due, then unseen); optional AI fill when `allow_generate=true` → `ai_generated_unreviewed`, labeled for the learner, queued for admin.
`GET /teaching/reads?topic=` — recent / older high-design / PubMed guidelines (12 mo) / **admin-curated high-yield only**.
`GET /teaching/guideline-updates` — approved admin-entered updates for census topics (verify-against-source).

**Coding (M2c):** `POST /patients/:id/coding/suggest` `{problem_id?}` — local ICD table retrieves candidates; model may only pick among them; draft artifact (not stored on the problem yet).
`POST /patients/:id/problems/:pid/coding/accept` `{code, artifact_id?}` — clinician accept writes `problems.code_suggestion`. Always labeled *"Suggestion for clinician/coder review. Not a billing determination."* Uncertain/differential problems are flagged; never coded as confirmed by the app.

**Reminders / check-rules (M3a):** `GET /patients/:id/reminders?date=` — approved rules only, matched deterministically to confirmed/differential problems (+ accepted ICD prefixes); framed as *"Prompt for your consideration"* (never orders/findings/urgency).
`POST /patients/:id/reminders/:ruleId/ack` `{state: checked|not_applicable|snoozed, note?, date?}` — workflow ack only, audited.

**Day brief (M3c):** `GET /round/brief?date=&team_id=` — deterministic per-patient cards (sort_order/room): summary_state, what_changed, trends, conflicts, pending items, tasks, approved reminders + yesterday comparisons, missing_information; counts for unreviewed facts / outdated summaries. **No AI ranking or urgency.**
`POST /round/brief/prepare` `{date?, patient_ids:[...]}` — bulk pre-generate presentations; respects daily AI cap; returns partial results with explicit failures (never silent skip).

**Team chat (M5):** `GET /channels`, `POST /channels` `{type: team|group|dm, ...}`, `GET /patients/:id/channel` (auto patient thread),
`GET/POST /channels/:id/messages`, `PATCH/DELETE /messages/:id` (soft delete), `POST /channels/:id/read` `{last_read_seq}`,
`GET /channels/unread`, `GET /channels/search?q=`, `GET /stream` (SSE, `Last-Event-ID` replay), `POST /chat/devices` (token hash only),
`POST /channels/:id/summarize` (explicit AI draft of that thread only). Attachments out of scope. Push payload must be generic ("New message") — never PHI.

**Admin (role=admin):** set `CORS_ORIGIN` to the admin panel origin (e.g. `https://admin.example.com`).  
`GET /admin/health` (provider, model, prompt version, db_ok, ICD loaded),  
`/admin/users` (includes `last_login_at`, `last_activity_at`; create; `PATCH` for role / deactivate / reset password ≥10 chars),  
`/admin/teams` (+members),  
`GET /admin/audit` filters: `actor_id`, `action`, `patient_id`, `from`, `to`, `limit`, `offset` → `{rows,total,limit,offset}`; `GET /admin/audit.csv` same filters,  
`/admin/settings` (AI kill switch, review intervals, `show_individual_learner_analytics` default **off**, `chat_enabled`, `chat_retention_days`, `chat_legal_hold` + `chat_legal_hold_reason` when toggling hold; settings also return chat `limits`, `push.registered_devices`, last retention/hold/purge metadata),
`GET /admin/chat/purge/preview` (eligible count / legal-hold block — no content), `POST /admin/chat/purge`,
`GET|POST /admin/chat/export` (`team_id` + required `reason`; response includes PHI — download only in admin UI), `GET /admin/chat/export/history` (metadata only),
`GET /admin/chat/hold/history`, `GET /admin/chat/metrics?from=&to=` (daily aggregates, no text),  
`/admin/templates`, `/admin/usage`, `/admin/analytics/activity`, `/admin/analytics/questions` (per-user learner rows only when setting on),  
`GET /admin/content/:type/:id/history` (`check-rule`|`mcq`|`curated-read`|`guideline-update`|`template`),  
`/admin/icd` (import status + CMS/CDC links),  
`/admin/check-rules` CRUD, `POST /admin/check-rules/:id/approve|retire`, `POST /admin/check-rules/draft` `{condition}` (AI candidate → always draft),  
`/admin/mcq-reports`, `GET /admin/mcqs` (review queue), `GET /admin/mcqs/:id` (full content for admin review), `PATCH /admin/mcqs/:id` `{status}` (`approved`|`retired`|`ai_generated_unreviewed`),  
`/admin/curated-reads` + `POST .../:id/approve`, `/admin/guideline-updates` + `POST .../:id/approve`  

Roles today: `admin`, `attending`, `resident`. A separate `reviewer` role (physician approver) is **not** enabled until confirmed.

## Checklist rule library (M3a)

Reminders come from an **admin-approved** rule library (`check_rules`), not free model invention. ~10 example rules (pyelo, stroke, pneumonia, CHF, AKI, DKA, sepsis, GI bleed, PE, cellulitis) seed as **`draft`** with `[EXAMPLE — review before approve]` in the name — they do nothing until `POST /admin/check-rules/:id/approve`.

- `match_json`: `{ problem_keywords, icd_prefixes }` matched in code against confirmed/differential problems and accepted ICD suggestions.
- `prompts_json`: `[{ text, kind: exam|review|lab|imaging|med }]`.
- `compare_json` (optional): `{ fact_label_keywords, lookback_days }` surfaces yesterday’s confirmed facts (with `fact_ids` + passages) for bedside comparison.
- AI helper `POST /admin/check-rules/draft` stores an **AI-drafted** candidate as draft only; invented citations are rejected.
- Acks are workflow state for that patient/day — not clinical documentation.

## ICD-10-CM import (M2c)

Codes come **only** from a local `icd10cm` table (never invented by the model). A tiny `fy=demo` subset is seeded so offline tests run; replace it with the official fiscal-year release:

1. Download **Code Descriptions in Tabular Order** for the current FY from [CDC ICD-10-CM files](https://www.cdc.gov/nchs/icd/icd-10-cm/files.html) or [CMS ICD-10](https://www.cms.gov/medicare/coding-billing/icd-10-codes) (CDC FTP example: `https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/2026/` → `icd10cm-order-2026.txt`).
2. Import:
   ```bash
   npm run import-icd -- path/to/icd10cm-order-2026.txt --fy=2026 --replace
   ```
3. Check: `GET /admin/icd` (count, fy, whether FTS5 is active). Search uses FTS5 when available, otherwise ranked `LIKE`.

## Note templates and the Admission H&P

Default templates (placeholders until your client supplies approved ones): `admit_hp`, `progress`, `icu`. Admins publish new
versions with `PUT /admin/templates/:key`; each section has a `source` that tells `validateNote` where its text may come from:

| `source` | Content may come from | Empty input |
|---|---|---|
| `clinician_history` | only `history[<section key>]` typed/dictated by the clinician (CC, HPI, PMH, medications, allergies, FH, SH, ROS) | `[<Title> not entered]` |
| `clinician_subjective` / `clinician_update` / `clinician_support` | the matching input field | `[<Title> not entered]` |
| `clinician_exam` | `exam` | `[<Title> not entered]` |
| `clinician_plan` | `plan` (or the saved plan for that date) | `[<Title> not entered]` |
| `facts` | confirmed facts only (cited by `fact_ids`) | no flag; empty text |
| `facts_and_exam` | confirmed facts + `exam` | no flag; empty text |

`POST /patients/:id/notes` body: `{ note_type: "admit_hp"|"progress"|"icu", note_date?, history?: { chief_complaint, hpi, pmh, medications, allergies, family_history, social_history, ros }, subjective?, exam?, update?, support?, plan?, inputs_from_source_ids?, apply_to? }`.
`history` keys not present in the active template are ignored and returned as `content.ignored_history_keys`. Model text for a section with no
clinician input is discarded. Any number in a section that is not in that section's clinician input (or the cited facts, for `facts` sections) is
flagged `unsupported_number`. A note with flags or `[... not entered]` placeholders cannot be marked reviewed. Missing inputs are listed in
`content.missing_information` (`clinician_history_<key>`, `clinician_exam`, ...). Adding a template via `PUT /admin/templates/admit_hp` takes effect immediately; existing artifacts keep their `template_version`.

### Notes from dictation (M2d)

Flow: `POST /transcribe` (or patient `intake` audio) → save text as a `sources` row (or reuse intake `dictation`) → `POST /patients/:id/notes` with `inputs_from_source_ids`.

- Array form: `"inputs_from_source_ids": ["<source_id>"]` plus optional `"apply_to": ["subjective"|"hpi"|"exam"|...]`. Defaults: progress → `subjective`, icu → `update`, admit_hp → `hpi`.
- Map form: `"inputs_from_source_ids": { "subjective": ["<id>"], "exam": ["<id>"], "history": { "hpi": ["<id>"] } }`.
- Explicit `subjective` / `history.hpi` / etc. in the body always win over source text.
- Response includes `content.fed_from_sources` (source ids + field names only). Sources must belong to the same patient.

## Typical Flutter flow

1. `POST /auth/login` -> store token.
2. `GET /patients` for the census (`summary_state`: Not generated / Draft ready / Reviewed / Outdated).
3. Add a source -> `POST .../sources/:sid/extract` -> show facts with `GET .../facts?status=pending` -> `POST .../facts/review`.
4. `POST .../summary` -> show claims; tap a claim's `fact_id` -> `GET /facts/:id/source` -> `POST /artifacts/:id/review`.
5. Next day: new facts -> `GET .../changes` (deterministic) and regenerate.
6. `POST .../notes` -> edit with `PATCH` -> `review` -> `export`.

## What this build deliberately does not do

- No EHR integration or writeback, no auto-signing, no orders, no urgency ranking, no diagnostic probabilities.
- "Considerations" (`/considerations`) is behind `FEATURE_CONSIDERATIONS=true`; keep it off until clinical evaluation passes.
- "Older evidence" means highest study-design level outside the recent window. It is **not** a curated landmark list.
- Teaching "high-yield" is **only** for admin-approved curated reads — never assigned by model opinion or PubMed retrieval.
- Guideline change feed is admin-entered (no scraping); PubMed guideline PT search is labeled "Guideline", not high-yield.
- Note templates and spaced-review intervals are placeholders; set your approved versions via the admin endpoints.
- Mock provider output is placeholder text; MCQs in mock mode are labeled `[MOCK CONTENT]`.

## Teaching mode (M4)

Census-driven learning without storing patient links on attempts or the plan:

1. `GET /teaching/plan` aggregates confirmed/differential problem labels → `topic_key` + counts.
2. `GET /teaching/questions?topic=` serves the **approved** bank first; set `allow_generate=true` only when you want AI draft questions (status `ai_generated_unreviewed`, learner label warns, admin reviews via `GET /admin/mcqs`).
3. `GET /teaching/reads?topic=` merges PubMed recent/older/guidelines with curated high-yield and approved guideline updates for that topic.
4. `GET /teaching/guideline-updates` lists approved admin updates for topics currently on the clinician's census.

## Team chat (M5)

Slack-like channels designed for PHI from day one (this software **does not claim HIPAA compliance**):

- Auto **patient threads** (team members only) + team `#general`, group channels, and teammate DMs. Cross-team access denied and audited.
- Soft-delete messages; audit who posted/read (IDs only). Rate limit + duplicate spam guard; max body 4000 chars.
- Realtime: authenticated `GET /stream` (SSE) scoped to the user's channels; reconnect with `Last-Event-ID` (message `seq`).
- Push: `POST /chat/devices` stores a **token hash**; any future FCM/APNs payload must be generic (`New message`) with **no** patient id or message text.
- Admin: `chat_enabled`, `chat_retention_days`, `chat_legal_hold` (reason + history), purge preview + purge (skipped under legal hold), compliance export (reason + history, PHI in payload for download only), chat metrics aggregates (counts only).
- AI: only `POST /channels/:id/summarize` on explicit request — draft/review artifact; AI must not silently read channels.
- Attachments: out of scope for M5.

**Compliance prerequisites (ops, not code):** TLS/HTTPS, encryption at rest for the database and backups, BAA with hosting and any push provider, documented retention, access controls, and incident response. Do not treat this MVP as a covered HIPAA product by itself.

## Before real use (not code, but required)

Security/privacy review, vendor agreement for any clinical data sent to a model provider, HTTPS in front of this server,
a strong `AUTH_SECRET`, a real `CORS_ORIGIN`, backups for `data/`, and clinical safety evaluation of every AI workflow.
For a larger deployment, swap SQLite for Postgres (all queries are in `db.js` and the route/orchestrator files).
