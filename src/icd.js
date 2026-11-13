import { all, get, run, hasIcdFts } from './db.js';

/**
 * Tiny fictional subset so tests and offline mock runs work without the CMS order file.
 * Replace by running: node scripts/import-icd.js path/to/icd10cm-order-YYYY.txt --fy=YYYY
 */
export const DEMO_ICD_CODES = [
  { code: 'J18.9', description: 'Pneumonia, unspecified organism', billable: 1, fy: 'demo' },
  { code: 'J15.9', description: 'Unspecified bacterial pneumonia', billable: 1, fy: 'demo' },
  { code: 'J12.9', description: 'Viral pneumonia, unspecified', billable: 1, fy: 'demo' },
  { code: 'N17.9', description: 'Acute kidney failure, unspecified', billable: 1, fy: 'demo' },
  { code: 'N17.0', description: 'Acute kidney failure with tubular necrosis', billable: 1, fy: 'demo' },
  { code: 'N18.3', description: 'Chronic kidney disease, stage 3 (moderate)', billable: 1, fy: 'demo' },
  { code: 'I50.9', description: 'Heart failure, unspecified', billable: 1, fy: 'demo' },
  { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications', billable: 1, fy: 'demo' },
  { code: 'A41.9', description: 'Sepsis, unspecified organism', billable: 1, fy: 'demo' },
  { code: 'I63.9', description: 'Cerebral infarction, unspecified', billable: 1, fy: 'demo' },
];

export function seedDemoIcdIfEmpty() {
  if (get('SELECT 1 AS x FROM icd10cm LIMIT 1')) return false;
  for (const row of DEMO_ICD_CODES) {
    run('INSERT OR IGNORE INTO icd10cm(code,description,billable,fy) VALUES(?,?,?,?)',
      row.code, row.description, row.billable, row.fy);
  }
  rebuildIcdFts();
  return true;
}

export function rebuildIcdFts() {
  if (!hasIcdFts()) return false;
  try {
    run('DELETE FROM icd10cm_fts');
    run('INSERT INTO icd10cm_fts(rowid, code, description) SELECT rowid, code, description FROM icd10cm');
    return true;
  } catch {
    return false;
  }
}

const tokens = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3);

/** Local retrieval only — never ask the model for codes. */
export function searchIcdCandidates(query, { limit = 12, billableOnly = true } = {}) {
  const terms = tokens(query);
  if (!terms.length) return [];
  const bill = billableOnly ? ' AND billable=1' : '';

  if (hasIcdFts()) {
    try {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
      const ftsHits = all(
        `SELECT c.code, c.description, c.billable, c.fy
         FROM icd10cm_fts f
         JOIN icd10cm c ON c.rowid = f.rowid
         WHERE icd10cm_fts MATCH ? ${billableOnly ? 'AND c.billable=1' : ''}
         ORDER BY rank
         LIMIT ?`,
        ftsQuery, limit,
      );
      if (ftsHits.length) return ftsHits;
    } catch { /* fall through to LIKE */ }
  }

  // Rank by how many query tokens appear in the description (deterministic).
  const rows = all(`SELECT code, description, billable, fy FROM icd10cm WHERE 1=1${bill}`);
  const scored = [];
  for (const r of rows) {
    const d = r.description.toLowerCase();
    let score = 0;
    for (const t of terms) if (d.includes(t)) score += 1;
    if (score) scored.push({ ...r, score });
  }
  scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return scored.slice(0, limit).map(({ code, description, billable, fy }) => ({ code, description, billable, fy }));
}

export function getIcdByCode(code) {
  return get('SELECT code, description, billable, fy FROM icd10cm WHERE code=?', String(code || '').trim().toUpperCase());
}

export function icdStats() {
  const n = get('SELECT COUNT(*) AS n FROM icd10cm')?.n || 0;
  const fy = get('SELECT fy FROM icd10cm WHERE fy != ? LIMIT 1', 'demo')?.fy || (n ? get('SELECT fy FROM icd10cm LIMIT 1')?.fy : null);
  return { count: n, fy, fts: hasIcdFts(), demo_only: !!get("SELECT 1 AS x FROM icd10cm WHERE fy='demo' LIMIT 1") && !get("SELECT 1 AS x FROM icd10cm WHERE fy!='demo' LIMIT 1") };
}
