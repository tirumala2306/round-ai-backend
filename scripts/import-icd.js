#!/usr/bin/env node
/**
 * Import ICD-10-CM codes from the official CDC/CMS "order" / code-descriptions file.
 *
 * Do NOT hardcode the code set in the app. Download the current fiscal-year release:
 *
 *   CDC ICD-10-CM files:
 *     https://www.cdc.gov/nchs/icd/icd-10-cm/files.html
 *   CMS ICD-10 page (Code Descriptions in Tabular Order ZIP):
 *     https://www.cms.gov/medicare/coding-billing/icd-10-codes
 *   CDC FTP (example FY2026):
 *     https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/2026/
 *     → icd10cm-Code Descriptions-2026.zip → icd10cm-order-2026.txt
 *
 * Usage:
 *   node scripts/import-icd.js path/to/icd10cm-order-2026.txt --fy=2026
 *   node scripts/import-icd.js path/to/order_file.txt --fy=2026 --replace
 *
 * Order-file layout (CDC fixed-width):
 *   cols 1-5 order#, 7-13 code (no dot), 15 billable flag (1=billable), 17-76 short, 77+ long desc.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, run, tx, get } from '../src/db.js';
import { config } from '../src/config.js';
import { rebuildIcdFts } from '../src/icd.js';

function parseArgs(argv) {
  const out = { file: null, fy: null, replace: false };
  for (const a of argv) {
    if (a === '--replace') out.replace = true;
    else if (a.startsWith('--fy=')) out.fy = a.slice(5);
    else if (!a.startsWith('-')) out.file = a;
  }
  return out;
}

/** Insert a decimal after the category for diagnosis codes (e.g. J189 → J18.9). */
export function formatIcdCode(raw) {
  const c = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length <= 3) return c;
  return `${c.slice(0, 3)}.${c.slice(3)}`;
}

export function parseOrderLine(line) {
  if (!line || line.length < 16) return null;
  // Prefer fixed-width CDC order format.
  if (line.length >= 17 && /^\d{5}/.test(line)) {
    const codeRaw = line.slice(6, 13).trim();
    const flag = line.slice(14, 15);
    const shortDesc = line.slice(16, 77).trim();
    const longDesc = line.slice(77).trim();
    if (!codeRaw) return null;
    return {
      code: formatIcdCode(codeRaw),
      description: longDesc || shortDesc,
      billable: flag === '1' ? 1 : 0,
    };
  }
  // Fallback: tab or pipe separated code + description (+ optional billable).
  const parts = line.split(/\t|\|/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2 && /^[A-TV-Z][0-9][A-Z0-9]/.test(parts[0].toUpperCase())) {
    return {
      code: formatIcdCode(parts[0]),
      description: parts[1],
      billable: parts[2] === '0' ? 0 : 1,
    };
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !args.fy) {
    console.error('Usage: node scripts/import-icd.js <order-file> --fy=YYYY [--replace]');
    console.error('Download: https://www.cdc.gov/nchs/icd/icd-10-cm/files.html');
    process.exit(1);
  }
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  openDb(config.dbPath);
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  let inserted = 0;
  let skipped = 0;

  tx(() => {
    if (args.replace) {
      run('DELETE FROM icd10cm');
      try { run('DELETE FROM icd10cm_fts'); } catch { /* no fts */ }
    }
    for (const line of lines) {
      const row = parseOrderLine(line);
      if (!row || !row.description) { skipped += 1; continue; }
      run('INSERT INTO icd10cm(code,description,billable,fy) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET description=excluded.description, billable=excluded.billable, fy=excluded.fy',
        row.code, row.description.slice(0, 500), row.billable, args.fy);
      inserted += 1;
    }
  });
  rebuildIcdFts();
  const total = get('SELECT COUNT(*) AS n FROM icd10cm').n;
  console.log(`Imported ${inserted} rows (skipped ${skipped}). Table now has ${total} codes for fy=${args.fy}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
