// Reusable facts and the proof packet. Pure functions: storage is done by lib/db.mjs or lib/blobstore.mjs.
// The trust rule is the same as for claims: a fact is "checked" only if its quote is in the document text,
// and that is decided here by the one existing checker in lib/ai.mjs, never by the model.
import { quoteVerified, pageOfQuote, parseDuration, addDuration, maskIds, normLang } from './ai.mjs';
import { newId } from './ids.mjs';

const qKey = (k, d, q) => `${k}|${d}|${String(q || '').toLowerCase().replace(/[‘’“”"'«»]/g, '').replace(/\s+/g, ' ').trim()}`;
const isoToday = () => new Date().toISOString().slice(0, 10);
const dayDiff = (iso, from = isoToday()) => Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5);

// Merges a fresh extraction into the stored facts. What the user did (confirm, include, correct) is kept.
export function mergeFacts(existing, extracted, token, now = new Date().toISOString()) {
  const out = [], used = new Set();
  for (const x of extracted || []) {
    const ex = existing.find((r) => !used.has(r.id) && qKey(r.label_key, r.document_id, r.quote) === qKey(x.nokkel, x.dok, x.sitat));
    const status = x.verifisert ? 'checked' : 'unchecked';
    if (ex) {
      used.add(ex.id);
      out.push(ex.check_status === 'user'
        ? { ...ex, page: x.side, updated_at: now }
        : { ...ex, label_text: x.etikett, value_text: x.verdi, page: x.side, source_kind: x.kilde, check_status: status, captured_on: x.fanget, valid_duration_text: x.gyldig, updated_at: now });
    } else {
      out.push({
        id: newId('x'), case_token: token, label_key: x.nokkel, label_text: x.etikett, value_text: x.verdi, quote: x.sitat, document_id: x.dok, page: x.side,
        source_kind: x.kilde, source_name: null, check_status: status, captured_on: x.fanget, valid_duration_text: x.gyldig,
        user_confirmed: 0, included_in_packet: status === 'checked' ? 1 : 0, created_at: now, updated_at: now, original_value: null, origin_kind: null,
      });
    }
  }
  // A fact the user confirmed or corrected is not dropped just because a new reading did not find it again.
  for (const r of existing) if (!used.has(r.id) && (r.check_status === 'user' || r.user_confirmed)) out.push(r);
  return out;
}

// What the user can change. Anything else is refused by the caller.
export function applyPatch(row, patch, now = new Date().toISOString()) {
  const r = { ...row, updated_at: now };
  if ('confirmed' in patch) r.user_confirmed = patch.confirmed ? 1 : 0;
  if ('included' in patch) r.included_in_packet = patch.included ? 1 : 0;
  if ('value' in patch) {
    const v = String(patch.value ?? '').trim().slice(0, 200);
    if (!v) throw Object.assign(new Error('empty'), { code: 'empty' });
    if (r.source_kind !== 'user') {
      r.origin_kind = r.source_kind; r.original_value = r.value_text; r.source_kind = 'user'; r.check_status = 'user';
    }
    r.value_text = v;
  }
  if ('validDuration' in patch) {
    const d = String(patch.validDuration ?? '').trim().slice(0, 60);
    if (d && !parseDuration(d)) throw Object.assign(new Error('duration'), { code: 'duration' });
    if (r.source_kind !== 'user') { r.origin_kind = r.source_kind; r.original_value = r.value_text; r.source_kind = 'user'; r.check_status = 'user'; }
    r.valid_duration_text = d || null;
  }
  return r;
}

// The view the client and the packet use. Status and valid_until are computed here, on every read.
export function factView(r, docs) {
  const doc = docs.find((d) => d.id === r.document_id) || null;
  let status;
  if (r.source_kind === 'user') status = 'user';
  else if (r.source_kind === 'external') status = 'external'; // reserved: nothing can produce it yet
  else if (!doc) status = 'missing';
  else status = quoteVerified(docs, doc.id, r.quote) ? 'checked' : 'unchecked';
  const kind = r.source_kind;
  const origin = kind === 'user' ? r.origin_kind : kind;

  let validity = null;
  const dur = parseDuration(r.valid_duration_text);
  if (dur) {
    const useReceived = dur.fromReceipt;
    const base = useReceived ? doc?.received : (origin === 'document' || origin === 'voice') && doc ? doc.date : r.captured_on;
    if (!base) validity = { state: 'need', need: useReceived ? 'received' : 'date', docId: doc?.id || null };
    else {
      const until = addDuration(base, dur.n, dur.unit);
      validity = { state: 'ok', until, base, baseKind: useReceived ? 'received' : 'document', n: dur.n, unit: dur.unit, days: dayDiff(until) };
    }
  }
  return {
    id: r.id, key: r.label_key, label: r.label_text || null, value: r.value_text,
    quote: r.quote || '', superseded: r.source_kind === 'user' && !!r.quote, originalValue: r.original_value || null,
    docId: r.document_id, docTitle: doc?.title || null, page: r.page || null, pages: doc ? doc.text.split('\f').length : 0,
    kind, origin: origin || null, status, checked: status === 'checked', sourceName: r.source_name || null,
    capturedOn: r.captured_on || null, validDuration: r.valid_duration_text || null, validity,
    confirmed: !!r.user_confirmed, included: !!r.included_in_packet,
  };
}

export const factViews = (rows, docs) => rows.map((r) => factView(r, docs));

/* ---------- Words, in both languages ---------- */
export const LABELS = {
  en: { inntekt: 'Income', adresse: 'Address', husstand: 'Household members', uforhet: 'Disability status', arbeidsstatus: 'Work status', diagnose: 'Diagnosis', saksnummer: 'Case or reference number', forsikring: 'Insurance', annet: 'Other' },
  nb: { inntekt: 'Inntekt', adresse: 'Adresse', husstand: 'Husstandsmedlemmer', uforhet: 'Uføre- eller funksjonsstatus', arbeidsstatus: 'Arbeidsstatus', diagnose: 'Diagnose', saksnummer: 'Sak- eller referansenummer', forsikring: 'Forsikring', annet: 'Annet' },
};
export const labelOf = (v, lang) => (v.key === 'annet' && v.label ? v.label : LABELS[lang][v.key] || LABELS[lang].annet);

const WORDS = {
  en: {
    checkedDoc: 'Checked against the document', checkedVoice: 'Checked against your voice note', voice: 'From your voice note, not an official document',
    unchecked: 'Could not be checked. Check yourself', user: 'Entered by you — not checked', missing: 'Source document deleted — check yourself',
    external: 'Checked against an external source', superseded: 'Original quote, replaced by your entry',
    title: 'Proof packet', fact: 'Fact', value: 'Value', source: 'Source', status: 'Verification', quote: 'Quote',
    page: (n) => `page ${n}`, none: 'No facts selected.', made: (d) => `Generated ${d}`, validUntil: 'Valid until',
    checkAgainst: 'Check any item against the original document.', notAdvice: 'Case Ally organizes and explains. It does not give legal advice.',
    footer: 'This is an AI analysis to organize and simplify. Always check official deadlines with the agency or its website.',
    hidden: 'Personal ID numbers we recognize have been hidden. This is pattern matching (Norwegian national ID, US Social Security number, Norwegian bank account number), not a guarantee. It misses other formats, names and addresses.',
    shown: 'ID numbers are shown in this packet.', print: 'Print or save as PDF', share: 'Anyone with this file or link can see what\'s in it. Only share it with people helping with the case.',
    case: 'Case', until: (d) => `valid until ${d}`,
  },
  nb: {
    checkedDoc: 'Kontrollert mot dokumentet', checkedVoice: 'Kontrollert mot talenotatet ditt', voice: 'Fra talenotatet ditt, ikke et offisielt dokument',
    unchecked: 'Kunne ikke kontrolleres. Sjekk selv', user: 'Skrevet inn av deg — ikke kontrollert', missing: 'Kildedokumentet er slettet — sjekk selv',
    external: 'Kontrollert mot en ekstern kilde', superseded: 'Opprinnelig sitat, erstattet av det du skrev inn',
    title: 'Bevispakke', fact: 'Fakta', value: 'Verdi', source: 'Kilde', status: 'Kontroll', quote: 'Sitat',
    page: (n) => `side ${n}`, none: 'Ingen fakta valgt.', made: (d) => `Laget ${d}`, validUntil: 'Gyldig til',
    checkAgainst: 'Sjekk alle opplysninger mot originaldokumentet.', notAdvice: 'Saksmappen organiserer og forklarer. Den gir ikke juridisk rådgivning.',
    footer: 'Dette er en KI-analyse for strukturering og forenkling. Sjekk alltid offisielle frister på Nav.no eller kommunens nettsider.',
    hidden: 'Personnumre vi kjenner igjen er skjult. Dette er mønstergjenkjenning (norsk fødselsnummer, amerikansk Social Security-nummer, norsk kontonummer), ikke en garanti. Andre formater, navn og adresser blir ikke fanget.',
    shown: 'Personnumre vises i denne pakken.', print: 'Skriv ut eller lagre som PDF', share: 'Alle som har denne filen eller lenken kan se innholdet. Del den bare med personer som hjelper til i saken.',
    case: 'Sak', until: (d) => `gyldig til ${d}`,
  },
};
export const words = (lang) => WORDS[normLang(lang)];

export function statusText(v, lang) {
  const w = words(lang);
  if (v.status === 'checked') return v.kind === 'voice' ? `${w.checkedVoice}. ${w.voice}` : w.checkedDoc;
  if (v.status === 'user') return v.origin === 'voice' ? `${w.user}. ${w.voice}` : w.user;
  if (v.status === 'missing') return w.missing;
  if (v.status === 'external') return `${w.external}${v.sourceName ? `: ${v.sourceName}` : ''}`;
  return w.unchecked;
}

const fmtDate = (iso, lang) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang === 'nb' ? 'nb-NO' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

// Exactly the facts the user included, nothing else. Both the page and the JSON are built from this list.
export function packetItems(rows, docs, { lang = 'en', hide = true, quotes = false } = {}) {
  lang = normLang(lang);
  const m = (s) => (hide ? maskIds(String(s ?? ''), lang) : String(s ?? ''));
  return factViews(rows.filter((r) => r.included_in_packet), docs).map((v) => ({
    fact: labelOf(v, lang), value: m(v.value),
    source: { kind: v.kind, document: v.docTitle ? m(v.docTitle) : null, page: v.page && v.pages > 1 ? v.page : null },
    quote: quotes && v.quote ? m(v.quote) : null,
    checked: v.checked, status: statusText(v, lang), superseded: quotes && v.superseded,
    capturedOn: v.capturedOn, validUntil: v.validity?.state === 'ok' ? v.validity.until : null,
  }));
}

export function packetJson(caseRow, rows, docs, opts) {
  const lang = normLang(opts.lang);
  return { case: opts.hide ? maskIds(caseRow.name, lang) : caseRow.name, generated: isoToday(), language: lang, idNumbersHidden: !!opts.hide, facts: packetItems(rows, docs, opts) };
}

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function packetHtml(caseRow, rows, docs, opts) {
  const lang = normLang(opts.lang), w = WORDS[lang];
  const data = packetJson(caseRow, rows, docs, { ...opts, lang });
  const label = w;
  const rowsHtml = data.facts.map((f) => `<tr>
    <th scope="row" data-label="${h(label.fact)}">${h(f.fact)}</th>
    <td data-label="${h(label.value)}" class="val">${h(f.value)}${f.validUntil ? `<br><span class="meta">${h(w.validUntil)}: ${h(fmtDate(f.validUntil, lang))}</span>` : ''}</td>
    <td data-label="${h(label.source)}">${f.source.document ? h(f.source.document) : ''}${f.source.page ? `, ${h(w.page(f.source.page))}` : ''}${f.capturedOn ? `<br><span class="meta">${h(fmtDate(f.capturedOn, lang))}</span>` : ''}</td>
    <td data-label="${h(label.status)}"><span class="st ${f.checked ? 'ok' : 'warn'}"><span aria-hidden="true">${f.checked ? '✓' : '!'}</span> ${h(f.status)}</span></td>
    ${opts.quotes ? `<td data-label="${h(label.quote)}">${f.quote ? `<blockquote>«${h(f.quote)}»</blockquote>${f.superseded ? `<span class="meta">${h(w.superseded)}</span>` : ''}` : ''}</td>` : ''}
  </tr>`).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${h(w.title)} · ${h(data.case)}</title>
<style>
:root{--bg:#F8F5EF;--ink:#14243B;--mute:#4A5A70;--line:#D9D3C7;--ok:#1E6B45;--amber:#7A5500;--amber-bg:#FFF4D6;--card:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:1rem/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.75rem;line-height:1.25;margin:0 0 4px}.meta{color:var(--mute);font-size:.875rem}
.bar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:16px 0}
button{font:inherit;min-height:44px;padding:8px 18px;border-radius:10px;border:1px solid var(--ink);background:var(--ink);color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #2B6CB0;outline-offset:2px}
.note{background:var(--amber-bg);color:var(--amber);border:1px solid #E7CF8E;border-radius:10px;padding:12px 16px;margin:16px 0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:12px 14px;border-bottom:1px solid var(--line);font-size:.9375rem;overflow-wrap:anywhere}thead th{background:#EFEADF;font-size:.875rem}
tbody th{font-weight:600}.val{font-size:1.125rem;font-weight:600}blockquote{margin:0;font-family:Georgia,serif;background:#F3F0E8;padding:8px 10px;border-radius:6px}
.st{display:inline-flex;gap:6px;align-items:baseline;font-weight:600}.st.ok{color:var(--ok)}.st.warn{color:var(--amber)}
footer{margin-top:24px;color:var(--mute);font-size:.875rem}footer p{margin:4px 0}
@media (max-width:700px){thead{position:absolute;left:-9999px}tr,td,tbody th{display:block}tr{border-bottom:6px solid var(--bg)}td::before,tbody th::before{content:attr(data-label);display:block;color:var(--mute);font-size:.875rem;font-weight:400}}
@media print{body{background:#fff}.noprint{display:none}main{padding:0}table{border-radius:0}}
</style></head><body><main>
<h1>${h(w.title)}</h1><p class="meta">${h(w.case)}: ${h(data.case)} · ${h(w.made(fmtDate(data.generated, lang)))}</p>
<div class="bar noprint"><p class="meta" style="margin:0;max-width:640px">${h(w.share)}</p><button type="button" onclick="window.print()">${h(w.print)}</button></div>
<div class="note">${h(opts.hide ? w.hidden : w.shown)}</div>
${data.facts.length ? `<table><thead><tr><th scope="col">${h(w.fact)}</th><th scope="col">${h(w.value)}</th><th scope="col">${h(w.source)}</th><th scope="col">${h(w.status)}</th>${opts.quotes ? `<th scope="col">${h(w.quote)}</th>` : ''}</tr></thead><tbody>${rowsHtml}</tbody></table>` : `<p>${h(w.none)}</p>`}
<footer><p>${h(w.checkAgainst)}</p><p>${h(w.notAdvice)}</p><p>${h(w.footer)}</p></footer>
</main></body></html>`;
}
