import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createHandler } from '../lib/app.mjs';
import { computeDeadlines } from '../lib/ai.mjs';

test('a duration from receipt gets its date from code once the received date is known', () => {
  const docs = [{ id: 'd1', date: '2026-10-14', received: '', text: 'You have 60 days from the date you receive this notice to appeal.' }];
  const f = [{ dato: null, varighet: { antall: 60, enhet: 'days' }, fra: 'mottak', dok: 'd1', sitat: 'You have 60 days from the date you receive this notice to appeal.' }];
  computeDeadlines(f, docs);
  assert.equal(f[0].dato, null);
  docs[0].received = '2026-10-16';
  computeDeadlines(f, docs);
  assert.equal(f[0].dato, '2026-12-15');
  assert.equal(f[0].beregnet, true);
});

test('API: recalc fills the appeal date without a model call and keeps the analysis fresh', async () => {
  const db = openDb(':memory:'), h = createHandler(db);
  const call = (m, p, b) => h(new Request(`http://x${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }));
  const { token } = await (await call('POST', '/api/cases/sample', { lang: 'en' })).json();
  const view = await (await call('GET', `/api/cases/${token}`)).json();
  const dec = view.documents.find((d) => d.title.startsWith('Decision'));
  await call('PUT', `/api/cases/${token}/documents/${dec.id}`, { title: dec.title, type: dec.type, date: dec.date, received: '2026-10-16', text: dec.text, source: dec.source });
  assert.equal((await (await call('GET', `/api/cases/${token}`)).json()).analysisState, 'stale');
  assert.equal((await (await call('POST', `/api/cases/${token}/recalc`, {})).json()).ok, true);
  const after = await (await call('GET', `/api/cases/${token}`)).json();
  assert.equal(after.analysisState, 'fresh');
  assert.equal(after.analysis.frister.find((f) => /appeal/i.test(f.hva)).dato, '2026-12-15');
});

test('a deadline in working days or end of month is not calculated, instead of being calculated wrongly', () => {
  const docs = [{ id: 'd1', date: '2026-10-14', received: '2026-10-16', text: '' }];
  const mk = (sitat, v) => [{ dato: null, varighet: v, fra: 'mottak', dok: 'd1', sitat }];
  const a = mk('You must respond within 5 working days of receipt of this letter.', { antall: 5, enhet: 'days' }); computeDeadlines(a, docs);
  assert.equal(a[0].dato, null); assert.equal(a[0].ikkeStottet, true);
  const b = mk('Fristen er utgangen av måneden etter datoen på dette brevet.', { antall: 1, enhet: 'months' }); computeDeadlines(b, docs);
  assert.equal(b[0].dato, null); assert.equal(b[0].ikkeStottet, true);
  const c = mk('You have 60 days from the date you receive this notice.', { antall: 60, enhet: 'days' }); computeDeadlines(c, docs);
  assert.equal(c[0].dato, '2026-12-15');
});
