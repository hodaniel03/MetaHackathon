// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../lib/db.mjs';
import { finishForTest } from './helpers.mjs';
import { mergeFacts, applyPatch, factView, packetItems, packetJson, packetHtml } from '../lib/facts.mjs';
import { createHandler } from '../lib/app.mjs';

const docs = [
  { id: 'd1', title: 'Decision', type: 'vedtak', date: '2026-03-03', received: '', text: 'Income is NOK 450 000 per year.\nThis decision is valid for 6 months.\fPage two: ID 12345678901.', source: 'tekst' },
  { id: 'd2', title: 'Voice note', type: 'notat', date: '2026-10-25', received: '', text: 'No income since May.', source: 'tale' },
  { id: 'd3', title: 'Letter', type: 'vedtak', date: '2026-10-01', received: '', text: 'Valid for 60 days from receipt.', source: 'tekst' },
];
const raw = (o) => ({ nokkel: 'inntekt', etikett: null, verdi: 'v', sitat: '', dok: 'd1', gyldig: null, ...o });
const extract = (items) => finishForTest({ fakta: items }, docs);

test('a tampered quote is stored unchecked', () => {
  const [ok, bad] = extract([raw({ sitat: 'Income is NOK 450 000 per year.' }), raw({ sitat: 'Income is NOK 950 000 per year.' })]);
  assert.equal(ok.verifisert, true);
  assert.equal(bad.verifisert, false);
  const rows = mergeFacts([], [ok, bad], 't');
  assert.deepEqual(rows.map((r) => r.check_status), ['checked', 'unchecked']);
  assert.deepEqual(rows.map((r) => r.included_in_packet), [1, 0]);
  assert.equal(factView(rows[1], docs).status, 'unchecked');
});

test('the page of a quote is found by code', () => {
  const [f] = extract([raw({ sitat: 'Page two: ID' })]);
  assert.equal(f.side, 2);
});

test('valid_until is computed by code: 6 months from 2026-03-03 is 2026-09-03', () => {
  const [f] = extract([raw({ sitat: 'This decision is valid for 6 months.', gyldig: '6 months' })]);
  assert.equal(f.gyldig, '6 months');
  const v = factView(mergeFacts([], [f], 't')[0], docs);
  assert.equal(v.validity.until, '2026-09-03');
  assert.equal(v.validity.base, '2026-03-03');
  assert.equal(v.validity.n, 6);
});

test('a duration that is not in the quote is dropped', () => {
  const [f] = extract([raw({ sitat: 'Income is NOK 450 000 per year.', gyldig: '12 months' })]);
  assert.equal(f.gyldig, null);
});

test('a duration from receipt asks for the received date instead of guessing', () => {
  const [f] = extract([raw({ dok: 'd3', sitat: 'Valid for 60 days from receipt.', gyldig: '60 days from receipt' })]);
  const row = mergeFacts([], [f], 't')[0];
  assert.deepEqual(factView(row, docs).validity, { state: 'need', need: 'received', docId: 'd3' });
  const withReceived = docs.map((d) => (d.id === 'd3' ? { ...d, received: '2026-10-16' } : d));
  assert.equal(factView(row, withReceived).validity.until, '2026-12-15');
});

test('a voice-note fact says so, and keeps it in the packet and JSON', () => {
  const [f] = extract([raw({ dok: 'd2', sitat: 'No income since May.' })]);
  assert.equal(f.kilde, 'voice');
  const rows = mergeFacts([], [f], 't');
  assert.equal(factView(rows[0], docs).kind, 'voice');
  const j = packetJson({ name: 'C' }, rows, docs, { lang: 'en', hide: true, quotes: true });
  assert.equal(j.facts[0].source.kind, 'voice');
  assert.match(j.facts[0].status, /voice note, not an official document/);
  assert.match(packetHtml({ name: 'C' }, rows, docs, { lang: 'en', hide: true, quotes: true }), /voice note, not an official document/);
});

test('a user correction loses the checked status everywhere', () => {
  const rows = mergeFacts([], extract([raw({ sitat: 'Income is NOK 450 000 per year.' })]), 't');
  const next = applyPatch(rows[0], { value: 'NOK 500 000' });
  const v = factView(next, docs);
  assert.equal(v.status, 'user');
  assert.equal(v.checked, false);
  assert.equal(v.superseded, true);
  assert.equal(v.originalValue, 'v');
  const j = packetJson({ name: 'C' }, [next], docs, { lang: 'en', hide: true, quotes: true });
  assert.equal(j.facts[0].checked, false);
  assert.equal(j.facts[0].source.kind, 'user');
  assert.match(j.facts[0].status, /Entered by you/);
  assert.throws(() => applyPatch(rows[0], { validDuration: 'soon' }));
});

test('re-reading keeps what the user did', () => {
  const x = extract([raw({ sitat: 'Income is NOK 450 000 per year.' })]);
  let rows = mergeFacts([], x, 't');
  rows = [applyPatch(applyPatch(rows[0], { confirmed: true }), { included: false })];
  const again = mergeFacts(rows, extract([raw({ verdi: 'new', sitat: 'Income is NOK 450 000 per year.' })]), 't');
  assert.equal(again.length, 1);
  assert.equal(again[0].user_confirmed, 1);
  assert.equal(again[0].included_in_packet, 0);
  assert.equal(again[0].id, rows[0].id);
});

test('a deleted source document flags the fact, it is not silently checked', () => {
  const rows = mergeFacts([], extract([raw({ sitat: 'Income is NOK 450 000 per year.' })]), 't');
  assert.equal(factView(rows[0], docs).status, 'checked');
  const gone = docs.filter((d) => d.id !== 'd1');
  assert.equal(factView(rows[0], gone).status, 'missing');
  assert.match(packetItems(rows, gone)[0].status, /Source document deleted/);
});

test('an edited document that no longer holds the quote makes the fact unchecked', () => {
  const rows = mergeFacts([], extract([raw({ sitat: 'Income is NOK 450 000 per year.' })]), 't');
  const edited = docs.map((d) => (d.id === 'd1' ? { ...d, text: 'Something else.' } : d));
  assert.equal(factView(rows[0], edited).status, 'unchecked');
});

test('the packet page and the JSON hold the same facts; ID numbers are hidden or shown', () => {
  const rows = mergeFacts([], extract([raw({ verdi: 'ID 12345678901', sitat: 'Page two: ID 12345678901.' }), raw({ nokkel: 'saksnummer', verdi: 'x', sitat: 'This decision is valid for 6 months.' })]), 't');
  for (const hide of [true, false]) {
    const o = { lang: 'en', hide, quotes: true };
    const j = packetJson({ name: 'C' }, rows, docs, o), html = packetHtml({ name: 'C' }, rows, docs, o);
    assert.equal(j.facts.length, 2);
    assert.equal((html.match(/<tbody>[\s\S]*<\/tbody>/)[0].match(/<tr>/g) || []).length, j.facts.length);
    assert.equal(JSON.stringify(j).includes('12345678901'), !hide);
    assert.equal(html.includes('12345678901'), !hide);
    assert.match(html, /Check any item against the original document\./);
    assert.match(html, /does not give legal advice/);
  }
  assert.match(packetHtml({ name: 'C' }, rows, docs, { lang: 'nb', hide: true }), /Nav\.no/);
});

test('only included facts are in the packet', () => {
  const rows = mergeFacts([], extract([raw({ sitat: 'Income is NOK 450 000 per year.' }), raw({ sitat: 'This decision is valid for 6 months.' })]), 't');
  rows[1] = applyPatch(rows[1], { included: false });
  assert.equal(packetItems(rows, docs).length, 1);
});

test('ideas are not facts: nothing in the facts code reads the ideas part', async () => {
  const ai = await import('../lib/ai.mjs');
  const out = ai.finishForTest({ ideer: [{ navn: 'Free legal aid', dok: 'd1', sitat: 'Income is NOK 450 000 per year.' }] }, docs, 'en');
  assert.ok(!('fakta' in out));
  const fs = await import('node:fs');
  assert.ok(!/ideer/.test(fs.readFileSync(new URL('../lib/facts.mjs', import.meta.url), 'utf8')));
});

/* ---- through the real handler and storage, including an old database ---- */
const call = (h, method, path, body) => h(new Request(`http://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
const jsonOf = (r) => r.json();

test('API: sample has facts; deleting a document flags them; deleting the case removes them', async () => {
  const db = openDb(':memory:');
  const h = createHandler(db);
  const { token } = await jsonOf(await call(h, 'POST', '/api/cases/sample', { lang: 'en' }));
  let facts = (await jsonOf(await call(h, 'GET', `/api/cases/${token}/facts`))).facts;
  assert.ok(facts.length >= 5);
  assert.ok(facts.some((f) => f.kind === 'voice'));
  assert.ok(facts.some((f) => f.validity?.state === 'ok'));
  assert.ok(facts.every((f) => f.status === 'checked'));
  assert.ok(!facts.some((f) => /legal aid|legal advice/i.test(f.value)));
  const docs1 = (await jsonOf(await call(h, 'GET', `/api/cases/${token}`))).documents;
  const d1 = docs1.find((d) => d.title.startsWith('Medical'));
  await call(h, 'DELETE', `/api/cases/${token}/documents/${d1.id}`);
  facts = (await jsonOf(await call(h, 'GET', `/api/cases/${token}/facts`))).facts;
  const fromD1 = facts.filter((f) => f.docId === d1.id);
  assert.ok(fromD1.length > 0 && fromD1.every((f) => f.status === 'missing'));
  assert.equal((await jsonOf(await call(h, 'GET', `/api/cases/${token}`))).analysisState, 'stale');
  await call(h, 'DELETE', `/api/cases/${token}`);
  assert.equal(db.getFacts(token).length, 0);
});

test('migration: a database from before facts opens, and its analysis asks for an update', async () => {
  const f = `/tmp/old-${Date.now()}.db`;
  const old = new DatabaseSync(f);
  old.exec(`CREATE TABLE cases (token TEXT PRIMARY KEY, name TEXT NOT NULL, person TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
    CREATE TABLE documents (id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES cases(token) ON DELETE CASCADE, title TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', received TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'tekst', created TEXT NOT NULL);
    CREATE TABLE analysis (token TEXT NOT NULL REFERENCES cases(token) ON DELETE CASCADE, part TEXT NOT NULL, content TEXT NOT NULL, hash TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (token, part));`);
  const tok = 'oldcaseoldcaseoldcase1';
  old.prepare('INSERT INTO cases VALUES (?,?,?,?)').run(tok, 'Old', '', new Date().toISOString());
  old.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)').run('d1', tok, 'T', 'annet', '2026-01-01', '', 'Text', 'tekst', new Date().toISOString());
  old.close();
  const db = openDb(f), h = createHandler(db);
  const hash = db.docsHash(db.documents(tok));
  for (const p of ['a', 'b', 'c', 'd']) db.saveAnalysisPart(tok, p, { sammendrag: 'x' }, hash);
  const view = await jsonOf(await call(h, 'GET', `/api/cases/${tok}`));
  assert.equal(view.analysisState, 'stale');
  assert.deepEqual(view.facts, []);
  assert.equal((await call(h, 'GET', `/api/cases/${tok}/packet.json`)).status, 200);
});
