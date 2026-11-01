// Tests the quote checker itself, with no model: takes real sentences from the synthetic documents and changes them.
// Run: node --no-warnings eval/quotecheck.mjs
import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const ai = await import(root + 'lib/ai.mjs');
const { CASES } = await import('./cases.mjs');

const docs = CASES.flatMap((c) => c.docs.map((d) => ({ ...d, id: `${c.id}/${d.id}` })));
const sentences = docs.flatMap((d) => d.text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 25).map((s) => ({ doc: d, s })));
const tests = {
  'exact quote': { want: true, make: (x) => x.s },
  'upper case and extra spaces': { want: true, make: (x) => ` ${x.s.toUpperCase().replace(/ /g, '  ')} ` },
  'curly quote marks around it': { want: true, make: (x) => `“${x.s}”` },
  'one digit changed': { want: false, make: (x) => (/\d/.test(x.s) ? x.s.replace(/\d/, (d) => String((Number(d) + 1) % 10)) : null) },
  'one word replaced': { want: false, make: (x) => { const w = x.s.split(' '); if (w.length < 5) return null; w[Math.floor(w.length / 2)] = 'banana'; return w.join(' '); } },
  'paraphrased (words reordered)': { want: false, make: (x) => { const w = x.s.split(' '); return w.length < 6 ? null : [...w.slice(3), ...w.slice(0, 3)].join(' '); } },
  'real quote, wrong document': { want: false, make: (x, i, all) => null },
};
const out = {};
for (const [name, t] of Object.entries(tests)) {
  let n = 0, right = 0;
  for (const [i, x] of sentences.entries()) {
    let q, doc = x.doc;
    if (name === 'real quote, wrong document') { const other = docs.find((d) => d.id !== x.doc.id && !d.text.toLowerCase().includes(x.s.toLowerCase().slice(0, 25))); q = x.s; doc = other; if (!other) continue; }
    else q = t.make(x);
    if (!q) continue;
    n++;
    if (ai.quoteVerified([{ id: 'x', text: doc.text }], 'x', q) === t.want) right++;
  }
  out[name] = { expected: t.want ? 'accepted' : 'rejected', tried: n, correct: right };
}
// What the checker cannot do: tell whether a quote supports a claim. A true quote used for a false claim passes.
const limit = { note: 'The checker only tests that the words are in the document. A real sentence attached to the wrong claim is accepted.', example: 'A deadline claim that quotes the sentence about a 48 hour cancellation is accepted if that sentence is in the document.' };
const result = { ran: new Date().toISOString(), sentences: sentences.length, documents: docs.length, tests: out, limit };
fs.writeFileSync(root + 'eval/results/quotecheck.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
