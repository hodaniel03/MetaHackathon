import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const rand = (bytes) => crypto.randomBytes(bytes).toString('base64url');
export const newToken = () => rand(16);
export const newId = (prefix) => prefix + crypto.randomBytes(5).toString('hex');
const now = () => new Date().toISOString();

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS cases (
      token TEXT PRIMARY KEY, name TEXT NOT NULL, person TEXT NOT NULL DEFAULT '', created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES cases(token) ON DELETE CASCADE,
      title TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', received TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'tekst', created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES cases(token) ON DELETE CASCADE,
      doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE, page INTEGER NOT NULL DEFAULT 1,
      mime TEXT NOT NULL, data BLOB NOT NULL, created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checks (
      token TEXT NOT NULL REFERENCES cases(token) ON DELETE CASCADE, key TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (token, key)
    );
    CREATE TABLE IF NOT EXISTS analysis (
      token TEXT NOT NULL REFERENCES cases(token) ON DELETE CASCADE, part TEXT NOT NULL,
      content TEXT NOT NULL, hash TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (token, part)
    );
  `);

  const q = (sql) => db.prepare(sql);
  const s = {
    insertCase: q('INSERT INTO cases (token, name, person, created) VALUES (?, ?, ?, ?)'),
    getCase: q('SELECT token, name, person, created FROM cases WHERE token = ?'),
    renameCase: q('UPDATE cases SET name = ?, person = ? WHERE token = ?'),
    deleteCase: q('DELETE FROM cases WHERE token = ?'),
    docs: q('SELECT id, title, type, date, received, text, source, created FROM documents WHERE token = ? ORDER BY CASE WHEN date = \'\' THEN created ELSE date END, created'),
    getDoc: q('SELECT id, title, type, date, received, text, source FROM documents WHERE token = ? AND id = ?'),
    insertDoc: q('INSERT INTO documents (id, token, title, type, date, received, text, source, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateDoc: q('UPDATE documents SET title = ?, type = ?, date = ?, received = ?, text = ? WHERE token = ? AND id = ?'),
    deleteDoc: q('DELETE FROM documents WHERE token = ? AND id = ?'),
    docFiles: q('SELECT id, doc_id, page FROM files WHERE token = ? AND doc_id IS NOT NULL ORDER BY page'),
    insertFile: q('INSERT INTO files (id, token, doc_id, page, mime, data, created) VALUES (?, ?, NULL, ?, ?, ?, ?)'),
    attachFile: q('UPDATE files SET doc_id = ?, page = ? WHERE id = ? AND token = ? AND doc_id IS NULL'),
    getFile: q('SELECT mime, data FROM files WHERE id = ? AND token = ?'),
    purgeOrphans: q('DELETE FROM files WHERE doc_id IS NULL AND created < ?'),
    getChecks: q('SELECT key FROM checks WHERE token = ? AND done = 1'),
    putCheck: q('INSERT INTO checks (token, key, done) VALUES (?, ?, ?) ON CONFLICT(token, key) DO UPDATE SET done = excluded.done'),
    getAnalysis: q('SELECT part, content, hash FROM analysis WHERE token = ?'),
    putAnalysis: q('INSERT INTO analysis (token, part, content, hash, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token, part) DO UPDATE SET content = excluded.content, hash = excluded.hash, created = excluded.created'),
  };

  const docsHash = (docs) =>
    crypto
      .createHash('sha256')
      .update(JSON.stringify(docs.map((d) => [d.id, d.title, d.type, d.date, d.received, d.text])))
      .digest('hex')
      .slice(0, 16);

  return {
    createCase(name, person = '') {
      const token = newToken();
      s.insertCase.run(token, name, person, now());
      return token;
    },
    getCase: (token) => s.getCase.get(token),
    updateCase: (token, name, person) => s.renameCase.run(name, person, token),
    deleteCase: (token) => s.deleteCase.run(token),

    documents(token) {
      const files = s.docFiles.all(token);
      return s.docs.all(token).map((d) => ({ ...d, files: files.filter((f) => f.doc_id === d.id).map((f) => f.id) }));
    },
    getDocument: (token, id) => s.getDoc.get(token, id),
    addDocument(token, d, fileIds = []) {
      const id = newId('d');
      s.insertDoc.run(id, token, d.title, d.type, d.date, d.received, d.text, d.source, now());
      fileIds.forEach((fid, i) => s.attachFile.run(id, i + 1, fid, token));
      return id;
    },
    updateDocument: (token, id, d) => s.updateDoc.run(d.title, d.type, d.date, d.received, d.text, token, id),
    deleteDocument: (token, id) => s.deleteDoc.run(token, id),

    addFile(token, mime, buf, page) {
      const id = newId('f');
      s.insertFile.run(id, token, page, mime, buf, now());
      return id;
    },
    getFile(token, id) {
      const r = s.getFile.get(id, token);
      return r && { mime: r.mime, data: Buffer.from(r.data) };
    },
    purgeOrphans: () => s.purgeOrphans.run(new Date(Date.now() - 3600_000).toISOString()),

    checks: (token) => Object.fromEntries(s.getChecks.all(token).map((r) => [r.key, true])),
    setCheck: (token, key, done) => s.putCheck.run(token, key, done ? 1 : 0),

    docsHash,
    saveAnalysisPart: (token, part, content, hash) => s.putAnalysis.run(token, part, JSON.stringify(content), hash, now()),
    analysis(token, currentHash, parts) {
      const rows = s.getAnalysis.all(token);
      if (!rows.length) return { state: 'none', data: null };
      const data = Object.assign({}, ...rows.map((r) => JSON.parse(r.content)));
      const complete = parts.every((p) => rows.some((r) => r.part === p));
      const fresh = complete && rows.every((r) => r.hash === currentHash);
      return { state: fresh ? 'fresh' : 'stale', data };
    },
  };
}
