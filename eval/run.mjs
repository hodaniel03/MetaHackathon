// Runs the real analysis on every synthetic case and scores it against the ground truth.
//   node --no-warnings eval/run.mjs            (all cases)
//   node --no-warnings eval/run.mjs en-01 nb-1 (only cases whose id starts with one of the arguments)
import fs from 'node:fs';
import path from 'node:path';
const root = new URL('..', import.meta.url).pathname;
for (const l of fs.readFileSync(root + '.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const ai = await import(root + 'lib/ai.mjs');
const { CASES } = await import('./cases.mjs');

const only = process.argv.slice(2);
const cases = CASES.filter((c) => !only.length || only.some((p) => c.id.startsWith(p)));
const CONC = 3;
const lc = (s) => String(s || '').toLowerCase();

async function runCase(c) {
  const docs = c.docs.map((d) => ({ ...d }));
  const t0 = Date.now();
  let out, error = null;
  try { out = await ai.analyzeParts(docs, null, c.lang); } catch (e) { error = e.message; out = {}; }
  const fr = out.frister || [];
  const dated = fr.filter((f) => f.dato);
  // Deadlines: an expected date counts as caught if some returned deadline has exactly that date.
  const caught = c.expect.deadlines.filter((d) => dated.some((f) => f.dato === d));
  const caughtFlagged = caught.filter((d) => dated.some((f) => f.dato === d && f.usikker)).length; // right date, but the app shows it as 'not in the document'
  const falseDated = dated.filter((f) => !c.expect.deadlines.includes(f.dato));
  const asksReceived = fr.some((f) => !f.dato && f.varighet && f.fra === 'mottak');
  // Missing: each expected item is an any-of keyword group, searched in what the app lists as missing.
  const miss = (out.mangler || []).map((m) => lc(`${m.hva} ${m.hvorfor} ${m.hvordan}`));
  const missCaught = c.expect.missing.filter((grp) => miss.some((m) => grp.some((k) => m.includes(lc(k)))));
  // Quote check: every item that carries a quote, and whether the server found it word for word in the document.
  const items = [];
  for (const [part, key] of [['timeline', 'tidslinje'], ['deadlines', 'frister'], ['missing', 'mangler'], ['ideas', 'ideer'], ['facts', 'fakta']]) for (const x of out[key] || []) if ('verifisert' in x) items.push({ part, ok: !!x.verifisert, quote: x.sitat });
  const failedQuotes = items.filter((i) => !i.ok);
  return {
    id: c.id, lang: c.lang, tags: c.tags, seconds: Math.round((Date.now() - t0) / 1000), error,
    expectedDeadlines: c.expect.deadlines, returnedDeadlines: fr.map((f) => ({ date: f.dato, what: f.hva, calculated: !!f.beregnet, unverifiedDate: !!f.usikker })),
    deadlinesCaught: caught.length, caughtButFlagged: caughtFlagged, deadlinesExpected: c.expect.deadlines.length, falseDatedDeadlines: falseDated.map((f) => f.dato),
    needsReceived: c.expect.needsReceived ? { expected: true, asked: asksReceived, noDatedGuess: dated.length === 0 } : null,
    forbidDated: c.expect.forbidDatedDeadline ? { invented: dated.length > 0 } : null,
    missingCaught: missCaught.length, missingExpected: c.expect.missing.length, missingListed: (out.mangler || []).map((m) => m.hva),
    quotes: { total: items.length, failed: failedQuotes.length, byPart: Object.fromEntries(['timeline', 'deadlines', 'missing', 'ideas', 'facts'].map((p) => [p, { total: items.filter((i) => i.part === p).length, failed: failedQuotes.filter((i) => i.part === p).length }])), failedExamples: failedQuotes.slice(0, 3).map((i) => `${i.part}: ${String(i.quote).slice(0, 120)}`) },
  };
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < cases.length) { const c = cases[next++]; const r = await runCase(c); results.push(r); console.log(`${r.id}  ${r.seconds}s  deadlines ${r.deadlinesCaught}/${r.deadlinesExpected}  missing ${r.missingCaught}/${r.missingExpected}  quotes failed ${r.quotes.failed}/${r.quotes.total}${r.error ? '  ERROR ' + r.error.slice(0, 80) : ''}`); }
}));
results.sort((a, b) => a.id.localeCompare(b.id));

const sum = (f) => results.reduce((n, r) => n + f(r), 0);
const noDeadlineCases = results.filter((r) => r.deadlinesExpected === 0 && !r.needsReceived && !r.forbidDated);
const summary = {
  model: process.env.CASEALLY_MODEL || process.env.META_MODEL || 'muse-spark-1.3',
  ran: new Date().toISOString(), cases: results.length, casesWithError: results.filter((r) => r.error).length,
  deadlines: { expected: sum((r) => r.deadlinesExpected), caught: sum((r) => r.deadlinesCaught), caughtButFlagged: sum((r) => r.caughtButFlagged), recall: +(sum((r) => r.deadlinesCaught) / Math.max(1, sum((r) => r.deadlinesExpected))).toFixed(3),
    falseDated: sum((r) => r.falseDatedDeadlines.length), casesWithFalseDated: results.filter((r) => r.falseDatedDeadlines.length).length },
  needsReceived: { cases: results.filter((r) => r.needsReceived).length, askedForReceivedDate: results.filter((r) => r.needsReceived?.asked && r.needsReceived.noDatedGuess).length },
  illegibleDate: { cases: results.filter((r) => r.forbidDated).length, invented: results.filter((r) => r.forbidDated?.invented).length },
  noDeadlineCases: { cases: noDeadlineCases.length, withInvented: noDeadlineCases.filter((r) => r.falseDatedDeadlines.length).length },
  missing: { expected: sum((r) => r.missingExpected), caught: sum((r) => r.missingCaught), recall: +(sum((r) => r.missingCaught) / Math.max(1, sum((r) => r.missingExpected))).toFixed(3) },
  quoteCheck: { quotes: sum((r) => r.quotes.total), notFoundWordForWord: sum((r) => r.quotes.failed), failRate: +(sum((r) => r.quotes.failed) / Math.max(1, sum((r) => r.quotes.total))).toFixed(3),
    byPart: Object.fromEntries(['timeline', 'deadlines', 'missing', 'ideas', 'facts'].map((p) => [p, { total: sum((r) => r.quotes.byPart[p].total), failed: sum((r) => r.quotes.byPart[p].failed) }])) },
  seconds: { mean: Math.round(sum((r) => r.seconds) / results.length), max: Math.max(...results.map((r) => r.seconds)) },
};
fs.mkdirSync(root + 'eval/results', { recursive: true });
fs.writeFileSync(root + 'eval/results/latest.json', JSON.stringify({ summary, results }, null, 2) + '\n');
fs.writeFileSync(root + 'eval/results/' + summary.ran.slice(0, 19).replace(/[:T]/g, '-') + '.json', JSON.stringify({ summary, results }, null, 2) + '\n');
console.log('\n' + JSON.stringify(summary, null, 2));
