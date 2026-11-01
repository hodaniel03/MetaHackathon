// Regenerates samples/<lang>.analysis.json from samples/<lang>.json with the real model.
// Usage: node --no-warnings scripts/regen-sample.mjs nb
import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
for (const l of fs.readFileSync(root + '.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const ai = await import(root + 'lib/ai.mjs');
const lang = process.argv[2] || 'en';
const s = JSON.parse(fs.readFileSync(`${root}samples/${lang}.json`, 'utf8'));
const docs = s.documents.map((d) => ({ id: d.id, title: d.title, type: d.type, date: d.date || '', received: '', text: d.text, source: d.source || 'tekst' }));
const parts = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((k) => ai.analyzePart(docs, k, lang)));
const out = Object.assign({}, ...parts);
// One fact with a quoted validity, so the sample shows the date arithmetic.
const valid = { en: { etikett: 'Statement validity', verdi: 'Valid for 6 months from the statement date', sitat: 'This statement is valid for 6 months from the date above.', gyldig: '6 months' }, nb: { etikett: 'Erklæringens gyldighet', verdi: 'Gyldig i 6 måneder fra erklæringsdatoen', sitat: 'Denne erklæringen er gyldig i 6 måneder fra datoen over.', gyldig: '6 måneder' } }[lang];
out.fakta = (out.fakta || []).filter((x) => !x.gyldig);
out.fakta.splice(Math.min(4, out.fakta.length), 0, { nokkel: 'annet', ...valid, dok: 'd1', verifisert: ai.quoteVerified(docs, 'd1', valid.sitat), side: ai.pageOfQuote(docs[0], valid.sitat), kilde: 'document', fanget: docs[0].date });
fs.writeFileSync(`${root}samples/${lang}.analysis.json`, JSON.stringify(out, null, 2) + '\n');
const q = Object.values(out).flat().filter((x) => x && typeof x === 'object' && 'verifisert' in x);
console.log(lang, 'quote-bearing items:', q.length, 'unverified:', q.filter((x) => !x.verifisert).length, '| ideas:', (out.ideer || []).map((i) => i.navn).join('; '));
