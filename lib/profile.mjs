// The verified profile and sharing it with programs. Pure functions; storage is a small JSON document per case
// (see getMeta/putMeta in lib/db.mjs and lib/blobstore.mjs).
//
// Everything here is fictional. The "sources" are SIMULATED: they return made-up values and are labelled as simulated
// everywhere they show. No real agency, register, bank or person is contacted.
import crypto from 'node:crypto';
import { normLang } from './ai.mjs';
import { newToken, newId } from './ids.mjs';

export const FIELDS = ['inntekt', 'husstand', 'bosted'];
const FACT_KEY = { inntekt: 'inntekt', husstand: 'husstand', bosted: 'adresse' };

export const FIELD_LABELS = {
  en: { inntekt: 'Income', husstand: 'Household', bosted: 'Place of residence' },
  nb: { inntekt: 'Inntekt', husstand: 'Husholdning', bosted: 'Bosted' },
};

// Simulated sources. Each says which fields it can fill.
export const SOURCES = {
  skatt: { fields: ['inntekt'], name: { en: 'Tax register (SIMULATED)', nb: 'Skatteregister (SIMULERT)' } },
  lonn: { fields: ['inntekt'], name: { en: 'Payroll records (SIMULATED)', nb: 'Lønnsopplysninger (SIMULERT)' } },
  folkeregister: { fields: ['husstand', 'bosted'], name: { en: 'Population register (SIMULATED)', nb: 'Folkeregister (SIMULERT)' } },
};

// Three fictional programs. No real agency, scheme or logo.
export const PROGRAMS = {
  bolig: { required: ['bosted', 'husstand', 'inntekt'], optional: [], name: { en: 'Housing support (FICTIONAL)', nb: 'Boligstøtte (FIKTIV)' }, agency: { en: 'Fictional Housing Board', nb: 'Fiktiv Boligetat' },
    purpose: { en: 'Checks where you live, who lives with you and your income.', nb: 'Sjekker hvor du bor, hvem du bor sammen med og inntekten din.' } },
  transport: { required: ['bosted', 'husstand'], optional: ['inntekt'], name: { en: 'Transport support (FICTIONAL)', nb: 'Transportstøtte (FIKTIV)' }, agency: { en: 'Fictional Mobility Office', nb: 'Fiktivt Mobilitetskontor' },
    purpose: { en: 'Checks where you live and who lives with you.', nb: 'Sjekker hvor du bor og hvem du bor sammen med.' } },
  rettshjelp: { required: ['inntekt', 'husstand'], optional: ['bosted'], name: { en: 'Free legal aid (FICTIONAL)', nb: 'Fri rettshjelp (FIKTIV)' }, agency: { en: 'Fictional Legal Aid Office', nb: 'Fiktivt Rettshjelpskontor' },
    purpose: { en: 'Checks your income and household size.', nb: 'Sjekker inntekten din og hvor mange som bor sammen.' } },
};
export const EXPIRY_DAYS = [7, 30, 90];

const isoToday = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const seed = (token, key) => parseInt(crypto.createHash('sha256').update(token + key).digest('hex').slice(0, 8), 16);
const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Deterministic, made-up values, so a demo gives the same answer twice.
export function simulate(token, sourceId, field, lang) {
  lang = normLang(lang);
  const src = SOURCES[sourceId];
  if (!src || !src.fields.includes(field)) return null;
  const n = seed(token, sourceId + field);
  let value;
  if (field === 'inntekt' && sourceId === 'skatt') value = lang === 'nb' ? `kr ${spaced(260000 + (n % 24) * 10000)} per år (skattemelding 2025)` : `NOK ${spaced(260000 + (n % 24) * 10000)} per year (2025 tax return)`;
  else if (field === 'inntekt') value = lang === 'nb' ? `kr ${spaced(20000 + (n % 12) * 1000)} per måned før skatt` : `NOK ${spaced(20000 + (n % 12) * 1000)} per month before tax`;
  else if (field === 'husstand') value = [lang === 'nb' ? '1 voksen' : '1 adult', lang === 'nb' ? '1 voksen og 1 barn' : '1 adult and 1 child', lang === 'nb' ? '2 voksne og 2 barn' : '2 adults and 2 children'][n % 3];
  else value = lang === 'nb' ? `Eksempelveien ${1 + (n % 40)}, 0000 Fiktivby` : `${1 + (n % 40)} Example Road, 0000 Fictional City`;
  return { id: sourceId, name: SOURCES[sourceId].name[lang], value, fetched: isoToday(), simulated: true };
}

export const emptyMeta = () => ({ sources: {}, consents: [], log: [] });

// One field of the profile: what the family claims (from the facts) next to what a source says, if one was fetched.
export function buildProfile(facts, meta, lang) {
  lang = normLang(lang);
  const rank = { checked: 0, user: 2, unchecked: 3, missing: 4 };
  return FIELDS.map((key) => {
    const cands = facts.filter((f) => f.key === FACT_KEY[key] && f.status !== 'external').sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || (a.kind === 'voice') - (b.kind === 'voice'));
    const c = cands[0];
    const claimed = c ? { value: c.value, kind: c.kind, origin: c.origin, status: c.status, doc: c.docTitle, quote: c.quote, capturedOn: c.capturedOn, factId: c.id } : null;
    const s = meta.sources[key];
    const source = s ? { id: s.id, name: SOURCES[s.id]?.name[lang] || s.name, value: s.value, fetched: s.fetched, simulated: true } : null;
    return { key, label: FIELD_LABELS[lang][key], claimed, source, state: source ? 'source' : claimed ? 'claimed' : 'empty' };
  });
}

export const programList = (lang) => Object.entries(PROGRAMS).map(([id, p]) => ({ id, name: p.name[normLang(lang)], agency: p.agency[normLang(lang)], purpose: p.purpose[normLang(lang)], required: p.required, optional: p.optional, fictional: true }));

// What the program is allowed to see: only the consented fields, as they were when consent was given.
function snapshotField(field, lang) {
  if (field.state === 'empty') return null;
  return field.state === 'source'
    ? { key: field.key, label: field.label, state: 'source', value: field.source.value, source: { name: field.source.name, fetched: field.source.fetched, simulated: true }, claimed: field.claimed && { value: field.claimed.value, kind: field.claimed.kind, origin: field.claimed.origin, status: field.claimed.status } }
    : { key: field.key, label: field.label, state: 'claimed', value: field.claimed.value, claimed: { value: field.claimed.value, kind: field.claimed.kind, origin: field.claimed.origin, status: field.claimed.status } };
}

export function grantConsent(meta, profile, { program, fields, days }, lang) {
  const p = PROGRAMS[program];
  if (!p) return { error: 'Unknown program.' };
  if (!EXPIRY_DAYS.includes(Number(days))) return { error: 'Choose how long the consent lasts.' };
  const allowed = [...p.required, ...p.optional];
  const chosen = [...new Set((Array.isArray(fields) ? fields : []).filter((f) => allowed.includes(f)))];
  const missingReq = p.required.filter((f) => !chosen.includes(f));
  if (missingReq.length) return { error: 'This program needs: ' + p.required.join(', ') + '.', code: 'required' };
  const snaps = chosen.map((k) => snapshotField(profile.find((f) => f.key === k), lang));
  if (snaps.some((x) => !x)) return { error: 'Some chosen fields have no value yet.', code: 'empty' };
  const today = isoToday();
  const consent = { id: newId('c'), program, fields: chosen, granted: today, expires: addDays(today, Number(days)), revoked: null, viewToken: newToken(), values: snaps };
  meta.consents.push(consent);
  log(meta, 'granted', consent);
  return { consent };
}

export function revokeConsent(meta, id) {
  const c = meta.consents.find((x) => x.id === id);
  if (!c) return null;
  if (!c.revoked) { c.revoked = isoToday(); log(meta, 'revoked', c); }
  return c;
}

export function log(meta, event, consent) {
  meta.log.push({ at: new Date().toISOString(), event, program: consent.program, consent: consent.id, fields: consent.fields });
  if (meta.log.length > 200) meta.log.splice(0, meta.log.length - 200);
}

export const consentState = (c, today = isoToday()) => (c.revoked ? 'revoked' : c.expires < today ? 'expired' : 'active');

export const consentView = (c, lang) => ({ id: c.id, program: c.program, programName: PROGRAMS[c.program].name[normLang(lang)], fields: c.fields, granted: c.granted, expires: c.expires, revoked: c.revoked, state: consentState(c), viewToken: c.viewToken });

// What a program sees when it opens its link. Revoked or expired consent shows nothing.
export function programView(c, lang) {
  lang = normLang(lang);
  const p = PROGRAMS[c.program], state = consentState(c);
  const base = { program: { id: c.program, name: p.name[lang], agency: p.agency[lang], fictional: true }, granted: c.granted, expires: c.expires, revoked: c.revoked, state };
  return state === 'active' ? { ...base, fields: c.values } : { ...base, fields: [] };
}
