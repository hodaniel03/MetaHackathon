// The public deployment stores everything in Netlify Blobs. This runs the same flows against lib/blobstore.mjs with an in-memory fake of the Blobs API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore } from '../lib/blobstore.mjs';
import { createHandler } from '../lib/app.mjs';

function fakeBlobs() {
  const m = new Map();
  return {
    async get(k, o) { if (!m.has(k)) return null; const v = m.get(k); return o?.type === 'json' ? JSON.parse(v.data) : v.data; },
    async setJSON(k, v) { m.set(k, { data: JSON.stringify(v) }); },
    async set(k, v, o) { m.set(k, { data: v, metadata: o?.metadata }); },
    async getWithMetadata(k) { const v = m.get(k); return v ? { data: v.data, metadata: v.metadata } : null; },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    keys: () => [...m.keys()],
  };
}

test('blob store: sample, facts, recalc, profile, consent, program view and delete', async () => {
  const fb = fakeBlobs(), store = createBlobStore(fb), h = createHandler(store, { hosted: true, env: { ACCESS_CODE: 'x', CASEALLY_API_KEY: 'k' } });
  const call = (m, p, b) => h(new Request(`http://x${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }), { ip: '1.1.1.1' });
  const { token } = await (await call('POST', '/api/cases/sample', { lang: 'en' })).json();
  const base = `/api/cases/${token}`;
  const view = await (await call('GET', base)).json();
  assert.equal(view.analysisState, 'fresh');
  assert.ok(view.facts.length >= 5);
  const dec = view.documents.find((d) => d.title.startsWith('Decision'));
  await call('PUT', `${base}/documents/${dec.id}`, { title: dec.title, type: dec.type, date: dec.date, received: '2026-10-16', text: dec.text, source: dec.source });
  assert.equal((await (await call('POST', `${base}/recalc`, {})).json()).ok, true);
  assert.equal((await (await call('GET', base)).json()).analysis.frister.find((f) => /appeal/i.test(f.hva)).dato, '2026-12-15');
  for (const [source, field] of [['folkeregister', 'husstand'], ['folkeregister', 'bosted'], ['skatt', 'inntekt']]) assert.equal((await call('POST', `${base}/profile/source`, { source, field })).status, 200);
  const o = await (await call('POST', `${base}/consents`, { program: 'transport', fields: ['bosted', 'husstand'], days: 30 })).json();
  const c = o.consents[0];
  const pv = await call('GET', `/api/view/${c.viewToken}`);
  assert.equal(pv.status, 200);
  assert.deepEqual((await pv.json()).fields.map((f) => f.key).sort(), ['bosted', 'husstand']);
  await call('DELETE', `${base}/consents/${c.id}`);
  assert.equal((await call('GET', `/api/view/${c.viewToken}`)).status, 410);
  assert.ok(fb.keys().some((k) => k.startsWith('m/')) && fb.keys().some((k) => k.startsWith('v/')));
  await call('DELETE', base);
  assert.equal((await call('GET', `/api/view/${c.viewToken}`)).status, 404);
  assert.deepEqual(fb.keys().filter((k) => k.includes(token) || k.startsWith('v/')), []);
});

test('hosted: live AI needs the access code, the sample and the program link do not', async () => {
  const store = createBlobStore(fakeBlobs()), h = createHandler(store, { hosted: true, env: { ACCESS_CODE: 'x', CASEALLY_API_KEY: 'k' } });
  const call = (m, p, b, hd = {}) => h(new Request(`http://x${p}`, { method: m, headers: { 'content-type': 'application/json', ...hd }, body: b ? JSON.stringify(b) : undefined }), { ip: '1.1.1.1' });
  const { token } = await (await call('POST', '/api/cases/sample', { lang: 'en' })).json();
  assert.equal((await call('POST', `/api/cases/${token}/ask`, { question: 'hi' })).status, 401);
  assert.equal((await call('POST', `/api/cases/${token}/recalc`, {})).status, 200);                    // calculation in code is not gated
  assert.equal((await call('POST', `/api/cases/${token}/profile/source`, { source: 'skatt', field: 'inntekt' })).status, 200); // simulated sources cost nothing
});
