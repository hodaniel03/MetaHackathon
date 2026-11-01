// Writes public/eval.json (what the app shows) from eval/results/latest.json and eval/results/quotecheck.json.
import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const { summary, results } = JSON.parse(fs.readFileSync(root + 'eval/results/latest.json', 'utf8'));
let qc = null; try { qc = JSON.parse(fs.readFileSync(root + 'eval/results/quotecheck.json', 'utf8')); } catch {}
const line = (r) => [`deadlines ${r.deadlinesCaught}/${r.deadlinesExpected}${r.caughtButFlagged ? ` (${r.caughtButFlagged} flagged as not in the document)` : ''}`, `missing ${r.missingCaught}/${r.missingExpected}`, `quotes not found ${r.quotes.failed}/${r.quotes.total}`, r.falseDatedDeadlines.length ? `invented dates: ${r.falseDatedDeadlines.join(', ')}` : '', r.needsReceived ? `asked for received date: ${r.needsReceived.asked && r.needsReceived.noDatedGuess ? 'yes' : 'no'}` : '', r.forbidDated ? `invented a date: ${r.forbidDated.invented ? 'yes' : 'no'}` : '', r.error ? `error: ${r.error.slice(0, 60)}` : ''].filter(Boolean).join(' · ');
fs.writeFileSync(root + 'public/eval.json', JSON.stringify({ summary, quoteCheckTest: qc && { tests: qc.tests, sentences: qc.sentences, limit: qc.limit }, cases: results.map((r) => ({ id: r.id, tags: r.tags, line: line(r) })) }) + '\n');
console.log('wrote public/eval.json', results.length, 'cases');
