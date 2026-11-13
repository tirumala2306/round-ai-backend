import { config } from '../config.js';
import { get, run } from '../db.js';
import { HttpError, sha, nowIso, jsonParse } from '../util.js';

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

let fetchImpl = (...a) => fetch(...a);
let gapMs = config.ncbi.apiKey ? 120 : 360; // NCBI: 3 req/s without key, 10 req/s with key
let lastCall = 0;
export function setEvidenceFetch(f, opts = {}) {
  fetchImpl = f;
  if (opts.gapMs !== undefined) gapMs = opts.gapMs;
}

export class EvidenceError extends Error {}

async function ncbi(endpoint, params) {
  const wait = lastCall + gapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const qs = new URLSearchParams({ db: 'pubmed', tool: config.ncbi.tool, ...params });
  if (config.ncbi.email) qs.set('email', config.ncbi.email);
  if (config.ncbi.apiKey) qs.set('api_key', config.ncbi.apiKey);
  let res;
  try {
    res = await fetchImpl(`${BASE}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(20000) });
  } catch { throw new EvidenceError('PubMed request failed'); }
  if (!res.ok) throw new EvidenceError(`PubMed returned ${res.status}`);
  return res;
}

/** Query text may never carry patient identifiers. Only a topic phrase is sent to PubMed. */
export function assertQuerySafe(topic, patient) {
  const t = String(topic || '').toLowerCase();
  const tokens = [...String(patient?.display_name || '').toLowerCase().split(/\s+/), String(patient?.room || '').toLowerCase()].filter((x) => x.length >= 3);
  if (tokens.some((x) => t.includes(x)) || /\b\d{6,}\b/.test(t) || /@/.test(t)) {
    throw new HttpError(422, 'query_not_safe', 'The search topic appears to contain patient identifiers. Use a generic clinical topic.');
  }
}

export function buildTerm(topic) {
  const cleaned = String(topic || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (cleaned.length < 3) throw new HttpError(422, 'topic_required', 'A clinical topic is required for evidence search.');
  return `"${cleaned}"[Title/Abstract] NOT "retracted publication"[Publication Type]`;
}

const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseEfetchXml(xml) {
  const out = [];
  for (const block of xml.match(/<PubmedArticle[\s>][\s\S]*?<\/PubmedArticle>/g) || []) {
    const pmid = (block.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1];
    const title = decode((block.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/) || [])[1] || '');
    if (!pmid || !title) continue;
    const journal = decode((block.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/) || [])[1] || '');
    let date = '';
    const ad = block.match(/<ArticleDate[^>]*>\s*<Year>(\d{4})<\/Year>\s*<Month>(\d{1,2})<\/Month>/);
    if (ad) date = `${ad[1]}-${ad[2].padStart(2, '0')}`;
    else {
      const pd = block.match(/<PubDate>\s*<Year>(\d{4})<\/Year>(?:\s*<Month>([A-Za-z0-9]+)<\/Month>)?/);
      if (pd) {
        const m = pd[2] ? (/^\d+$/.test(pd[2]) ? Number(pd[2]) : MONTHS[pd[2].slice(0, 3).toLowerCase()]) : null;
        date = m ? `${pd[1]}-${String(m).padStart(2, '0')}` : pd[1];
      } else date = (block.match(/<MedlineDate>(\d{4})/) || [])[1] || '';
    }
    const abstract = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
      .map((m) => { const label = (m[1].match(/Label="([^"]+)"/) || [])[1]; return `${label ? label + ': ' : ''}${decode(m[2])}`; })
      .join(' ').trim();
    const pubTypes = [...block.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g)].map((m) => decode(m[1]));
    const doi = (block.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/) || [])[1] || '';
    const notices = [...new Set([...block.matchAll(/RefType="(RetractionIn|ErratumIn|CorrectedandRepublishedIn)"/gi)].map((m) => m[1]))];
    const retracted = notices.some((n) => /retractionin/i.test(n)) || pubTypes.includes('Retracted Publication');
    out.push({ pmid, title, journal, date, abstract, pubTypes, doi, notices, retracted });
  }
  return out;
}

const TYPE_ORDER = [
  ['Practice Guideline', 'Guideline', 6], ['Guideline', 'Guideline', 6], ['Meta-Analysis', 'Meta-analysis', 5],
  ['Systematic Review', 'Systematic review', 5], ['Randomized Controlled Trial', 'Randomized controlled trial', 5],
  ['Clinical Trial', 'Clinical trial', 3], ['Observational Study', 'Observational study', 2],
  ['Review', 'Review', 2], ['Case Reports', 'Case report', 1], ['Preprint', 'Preprint', 1],
];
const EXCLUDE_TYPES = new Set(['Editorial', 'Comment', 'Letter', 'News', 'Published Erratum', 'Retraction of Publication']);

function classify(pubTypes) {
  for (const [pt, label, weight] of TYPE_ORDER) if (pubTypes.includes(pt)) return { study_type: label, weight };
  return { study_type: pubTypes[0] || 'Unclassified', weight: 1 };
}

async function fetchSet(term, { reldate, retmax = config.limits.maxEvidenceCandidates }) {
  const params = { term, retmode: 'json', retmax: String(retmax), sort: 'relevance' };
  if (reldate) { params.datetype = 'pdat'; params.reldate = String(reldate); }
  const search = await (await ncbi('esearch.fcgi', params)).json();
  const ids = search?.esearchresult?.idlist || [];
  if (!ids.length) return { records: [], excluded: [] };
  const xml = await (await ncbi('efetch.fcgi', { id: ids.join(','), retmode: 'xml' })).text();
  const parsed = parseEfetchXml(xml);
  const order = new Map(ids.map((id, i) => [id, i]));
  const seen = new Set();
  const excluded = [];
  const records = [];
  for (const r of parsed) {
    if (seen.has(r.pmid)) continue;
    seen.add(r.pmid);
    if (r.retracted) { excluded.push(r.pmid); continue; }
    if (r.pubTypes.some((t) => EXCLUDE_TYPES.has(t))) continue;
    const { study_type, weight } = classify(r.pubTypes);
    const year = Number(r.date.slice(0, 4)) || 0;
    const recency = year ? Math.max(0, 2 - (new Date().getFullYear() - year) * 0.4) : 0;
    records.push({
      evidence_id: `pmid:${r.pmid}`, pmid: r.pmid, title: r.title, journal: r.journal, date: r.date,
      study_type, notices: r.notices, doi: r.doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`, // built from PMID, never from model text
      access_level: r.abstract ? 'Abstract only' : 'Source not available',
      abstract: r.abstract,
      score: weight * 10 + recency - (order.get(r.pmid) ?? 30) * 0.2,
    });
  }
  records.sort((a, b) => b.score - a.score);
  return { records, excluded };
}

/**
 * Retrieval comes from PubMed only. Nothing is ever supplied from model memory.
 * "older" = highest study-design level outside the recent window. It is NOT a curated landmark list.
 */
export async function searchEvidence({ topic, months = 24, includeOlder = true, force = false }) {
  const term = buildTerm(topic);
  const key = sha(JSON.stringify({ term, months, includeOlder, v: config.versions.evidencePolicy }));
  if (!force) {
    const row = get('SELECT results, searched_at FROM evidence_cache WHERE cache_key=?', key);
    if (row && Date.now() - Date.parse(row.searched_at) < 24 * 3600_000) return { ...jsonParse(row.results), from_cache: true, last_checked: row.searched_at };
  }
  const recent = await fetchSet(term, { reldate: Math.round(months * 30.4) });
  let older = { records: [], excluded: [] };
  if (includeOlder) {
    const design = '("randomized controlled trial"[Publication Type] OR "meta-analysis"[Publication Type] OR "systematic review"[Publication Type] OR "practice guideline"[Publication Type])';
    older = await fetchSet(`${term} AND ${design}`, { retmax: 15 });
    const recentIds = new Set(recent.records.map((r) => r.pmid));
    older.records = older.records.filter((r) => !recentIds.has(r.pmid)).slice(0, 5);
  }
  const searchedAt = nowIso();
  const result = {
    topic, term, search_date: searchedAt, window_months: months, sources: ['PubMed (NCBI E-utilities)'],
    filters: { retracted: 'excluded', excluded_types: [...EXCLUDE_TYPES] },
    recent: recent.records, older: older.records, excluded_retracted: new Set([...recent.excluded, ...older.excluded]).size,
  };
  run('INSERT INTO evidence_cache(cache_key,query,params,results,searched_at) VALUES(?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET results=excluded.results, searched_at=excluded.searched_at',
    key, term, JSON.stringify({ months, includeOlder }), JSON.stringify(result), searchedAt);
  return { ...result, from_cache: false, last_checked: searchedAt };
}

/** Recent practice guidelines / guidelines (last N months). Labels stay honest — never "high-yield". */
export async function searchGuidelines({ topic, months = 12, force = false }) {
  const cleaned = String(topic || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (cleaned.length < 3) throw new HttpError(422, 'topic_required', 'A clinical topic is required for guideline search.');
  const term = `"${cleaned}"[Title/Abstract] AND ("Practice Guideline"[pt] OR "Guideline"[pt]) NOT "retracted publication"[Publication Type]`;
  const key = sha(JSON.stringify({ term, months, kind: 'guidelines', v: config.versions.evidencePolicy }));
  if (!force) {
    const row = get('SELECT results, searched_at FROM evidence_cache WHERE cache_key=?', key);
    if (row && Date.now() - Date.parse(row.searched_at) < 24 * 3600_000) {
      return { ...jsonParse(row.results), from_cache: true, last_checked: row.searched_at };
    }
  }
  const hit = await fetchSet(term, { reldate: Math.round(months * 30.4), retmax: 20 });
  const searchedAt = nowIso();
  const result = {
    topic: cleaned, term, search_date: searchedAt, window_months: months,
    sources: ['PubMed (NCBI E-utilities)'],
    records: hit.records.slice(0, 10),
    excluded_retracted: hit.excluded.length,
  };
  run('INSERT INTO evidence_cache(cache_key,query,params,results,searched_at) VALUES(?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET results=excluded.results, searched_at=excluded.searched_at',
    key, term, JSON.stringify({ months, kind: 'guidelines' }), JSON.stringify(result), searchedAt);
  return { ...result, from_cache: false, last_checked: searchedAt };
}

/** Public card: abstract text stays server-side. */
export const publicCard = ({ abstract, score, ...rest }) => rest;
