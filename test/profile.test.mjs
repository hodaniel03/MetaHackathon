import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createHandler } from '../lib/app.mjs';

const setup = async () => {
  const db = openDb(':memory:'), h = createHandler(db);
  const call = (m, p, b) => h(new Request(`http://x${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }));
  const { token } = await (await call('POST', '/api/cases/sample', { lang: 'en' })).json();
  return { db, call, token, base: `/api/cases/${token}` };
};
const get = async (r) => r.json();

test('profile: claimed values come from facts, source values are labelled simulated', async () => {
  const { call, base } = await setup();
  let p = await get(await call('GET', `${base}/profile?lang=en`));
  assert.deepEqual(p.fields.map((f) => f.key), ['inntekt', 'husstand', 'bosted']);
  assert.equal(p.fields[0].state, 'claimed');          // income was claimed in the voice note
  assert.equal(p.fields[1].state, 'empty');
  p = await get(await call('POST', `${base}/profile/source?lang=en`, { source: 'folkeregister', field: 'husstand' }));
  const h = p.fields.find((f) => f.key === 'husstand');
  assert.equal(h.state, 'source');
  assert.equal(h.source.simulated, true);
  assert.match(h.source.name, /SIMULATED/);
  assert.equal((await call('POST', `${base}/profile/source`, { source: 'skatt', field: 'bosted' })).status, 400);   // a source cannot fill any field
  // the same case gives the same simulated value twice
  const again = await get(await call('POST', `${base}/profile/source?lang=en`, { source: 'folkeregister', field: 'husstand' }));
  assert.equal(again.fields.find((f) => f.key === 'husstand').source.value, h.source.value);
});

test('consent: required fields, expiry, view, revoke, log', async () => {
  const { call, base } = await setup();
  for (const [source, field] of [['folkeregister', 'husstand'], ['folkeregister', 'bosted'], ['skatt', 'inntekt']]) await call('POST', `${base}/profile/source`, { source, field });
  // a program needs all of its fields
  assert.equal((await call('POST', `${base}/consents`, { program: 'bolig', fields: ['bosted'], days: 30 })).status, 400);
  assert.equal((await call('POST', `${base}/consents`, { program: 'bolig', fields: ['bosted', 'husstand', 'inntekt'], days: 5 })).status, 400);
  let o = await get(await call('POST', `${base}/consents`, { program: 'transport', fields: ['bosted', 'husstand'], days: 30 }));
  o = await get(await call('POST', `${base}/consents`, { program: 'rettshjelp', fields: ['inntekt', 'husstand'], days: 7 }));
  assert.equal(o.consents.length, 2);
  const c = o.consents.find((x) => x.program === 'transport');
  // the program sees only the consented fields, each with its provenance
  const v = await call('GET', `/api/view/${c.viewToken}?lang=en`);
  assert.equal(v.status, 200);
  const view = await get(v);
  assert.deepEqual(view.fields.map((f) => f.key).sort(), ['bosted', 'husstand']);
  assert.ok(view.fields.every((f) => f.state === 'source' && f.source.simulated));
  assert.ok(!JSON.stringify(view).includes('Jordan'));       // no case name or person
  // revoke: the same link now shows nothing
  o = await get(await call('DELETE', `${base}/consents/${c.id}`));
  assert.equal(o.consents.find((x) => x.id === c.id).state, 'revoked');
  const gone = await call('GET', `/api/view/${c.viewToken}`);
  assert.equal(gone.status, 410);
  assert.deepEqual((await get(gone)).fields, []);
  const events = o.log.map((l) => l.event);
  assert.ok(events.includes('granted') && events.includes('revoked'));
  const after = await get(await call('GET', `${base}/profile`));
  assert.ok(after.log.some((l) => l.event === 'viewed') && after.log.some((l) => l.event === 'denied-revoked'));
});

test('a claimed-only field is shown to the program as claimed, not verified', async () => {
  const { call, base } = await setup();
  await call('POST', `${base}/profile/source`, { source: 'folkeregister', field: 'husstand' });
  await call('POST', `${base}/profile/source`, { source: 'folkeregister', field: 'bosted' });
  await get(await call('POST', `${base}/consents`, { program: 'rettshjelp', fields: ['inntekt', 'husstand'], days: 30 }));
  const o = await get(await call('GET', `${base}/profile`));
  const view = await get(await call('GET', `/api/view/${o.consents[0].viewToken}`));
  const inc = view.fields.find((f) => f.key === 'inntekt');
  assert.equal(inc.state, 'claimed');
  assert.equal(inc.source, undefined);
  assert.equal(inc.claimed.origin ?? inc.claimed.kind, 'voice');
});

test('deleting the case removes sources, consents and the program link', async () => {
  const { db, call, base } = await setup();
  await call('POST', `${base}/profile/source`, { source: 'folkeregister', field: 'husstand' });
  await call('POST', `${base}/profile/source`, { source: 'folkeregister', field: 'bosted' });
  const o = await get(await call('POST', `${base}/consents`, { program: 'transport', fields: ['bosted', 'husstand'], days: 7 }));
  const vt = o.consents[0].viewToken;
  await call('DELETE', base);
  assert.equal((await call('GET', `/api/view/${vt}`)).status, 404);
});
