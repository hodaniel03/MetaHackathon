// The same storage interface as lib/db.mjs, on Netlify Blobs, for the public deployment.
// Layout:  c/<token>          the case: name, documents, file list (JSON)
//          k/<token>          ticked checklist items (JSON)
//          x/<token>          reusable facts (JSON array)
//          m/<token>          profile sources, consents, access log (JSON)
//          v/<viewToken>      program link -> {token, consentId}
//          a/<token>/<part>   one analysis part (JSON)
//          f/<token>/<id>     an uploaded image or PDF (binary, mime in metadata)
//          u/<counter>        usage counters for the daily and hourly caps
import crypto from 'node:crypto';
import { newToken, newId } from './ids.mjs';

const now = () => new Date().toISOString();

export function createBlobStore(store) {
  const get = (key) => store.get(key, { type: 'json' });
  const put = (key, value) => store.setJSON(key, value);
  const loadCase = (token) => get(`c/${token}`);

  const docsHash = (docs) =>
    crypto
      .createHash('sha256')
      .update(JSON.stringify(docs.map((d) => [d.id, d.title, d.type, d.date, d.received, d.text])))
      .digest('hex')
      .slice(0, 16);

  async function removePrefix(prefix) {
    const { blobs } = await store.list({ prefix });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
  }

  return {
    async createCase(name, person = '') {
      const token = newToken();
      await put(`c/${token}`, { token, name, person, created: now(), docs: [], files: [] });
      return token;
    },
    getCase: loadCase,
    async updateCase(token, name, person) {
      const c = await loadCase(token);
      await put(`c/${token}`, { ...c, name, person });
    },
    async deleteCase(token) {
      const meta = await get(`m/${token}`);
      await Promise.all((meta?.consents || []).map((c) => store.delete(`v/${c.viewToken}`)));
      await store.delete(`m/${token}`);
      await Promise.all([removePrefix(`a/${token}/`), removePrefix(`f/${token}/`), store.delete(`k/${token}`), store.delete(`x/${token}`), store.delete(`c/${token}`)]);
    },

    async documents(token) {
      const c = await loadCase(token);
      if (!c) return [];
      const docs = [...c.docs].sort((a, b) => (a.date || a.created).localeCompare(b.date || b.created) || a.created.localeCompare(b.created));
      return docs.map((d) => {
        const mine = c.files.filter((f) => f.doc === d.id).sort((a, b) => a.page - b.page), pdf = mine.find((f) => f.mime === 'application/pdf');
        return { ...d, files: mine.filter((f) => f.mime !== 'application/pdf').map((f) => f.id), pdf: pdf ? pdf.id : null };
      });
    },
    async getDocument(token, id) {
      const c = await loadCase(token);
      return c?.docs.find((d) => d.id === id) || null;
    },
    async addDocument(token, d, fileIds = []) {
      const c = await loadCase(token);
      const id = newId('d');
      c.docs.push({ id, title: d.title, type: d.type, date: d.date, received: d.received, text: d.text, source: d.source, created: now() });
      fileIds.forEach((fid, i) => {
        const f = c.files.find((x) => x.id === fid && !x.doc);
        if (f) { f.doc = id; f.page = i + 1; }
      });
      await put(`c/${token}`, c);
      return id;
    },
    async updateDocument(token, id, d) {
      const c = await loadCase(token);
      const doc = c.docs.find((x) => x.id === id);
      Object.assign(doc, { title: d.title, type: d.type, date: d.date, received: d.received, text: d.text });
      await put(`c/${token}`, c);
    },
    async deleteDocument(token, id) {
      const c = await loadCase(token);
      const gone = c.files.filter((f) => f.doc === id);
      c.docs = c.docs.filter((d) => d.id !== id);
      c.files = c.files.filter((f) => f.doc !== id);
      await put(`c/${token}`, c);
      await Promise.all(gone.map((f) => store.delete(`f/${token}/${f.id}`)));
    },

    async addFile(token, mime, buf, page) {
      const id = newId('f');
      const c = await loadCase(token);
      await store.set(`f/${token}/${id}`, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { metadata: { mime } });
      c.files.push({ id, doc: null, page, mime, created: now() });
      await put(`c/${token}`, c);
      return id;
    },
    async getFile(token, id) {
      const r = await store.getWithMetadata(`f/${token}/${id}`, { type: 'arrayBuffer' });
      return r && { mime: r.metadata?.mime || 'application/octet-stream', data: Buffer.from(r.data) };
    },

    async checks(token) {
      return (await get(`k/${token}`)) || {};
    },
    async setCheck(token, key, done) {
      const k = (await get(`k/${token}`)) || {};
      if (done) k[key] = true; else delete k[key];
      await put(`k/${token}`, k);
    },

    getMeta: (token) => get(`m/${token}`),
    putMeta: (token, obj) => put(`m/${token}`, obj),
    putView: (viewToken, token, consentId) => put(`v/${viewToken}`, { token, consentId }),
    getView: (viewToken) => get(`v/${viewToken}`),

    getFacts: async (token) => (await get(`x/${token}`)) || [],
    putFacts: (token, rows) => put(`x/${token}`, rows),

    docsHash,
    saveAnalysisPart: (token, part, content, hash) => put(`a/${token}/${part}`, { content, hash }),
    async analysis(token, currentHash, parts) {
      const rows = (await Promise.all(parts.map(async (p) => [p, await get(`a/${token}/${p}`)]))).filter(([, r]) => r);
      if (!rows.length) return { state: 'none', data: null };
      const data = Object.assign({}, ...rows.map(([, r]) => r.content));
      const fresh = rows.length === parts.length && rows.every(([, r]) => r.hash === currentHash);
      return { state: fresh ? 'fresh' : 'stale', data };
    },

    // Counts one use of a named counter and returns the new total.
    // Not atomic, which is fine for a safety cap: a burst can overshoot by a few calls.
    async bump(name) {
      const k = `u/${name}`;
      const n = ((await get(k)) || 0) + 1;
      await put(k, n);
      return n;
    },

    // Used by the scheduled cleanup.
    async purgeOlderThan(days) {
      const cutoff = Date.now() - days * 86400_000;
      const { blobs } = await store.list({ prefix: 'c/' });
      let n = 0;
      for (const b of blobs) {
        const c = await get(b.key);
        if (c && Date.parse(c.created) < cutoff) { await this.deleteCase(c.token); n++; }
      }
      const { blobs: usage } = await store.list({ prefix: 'u/' });
      await Promise.all(usage.filter((b) => !b.key.includes(new Date().toISOString().slice(0, 10))).map((b) => store.delete(b.key)));
      return n;
    },
  };
}
