import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const { openDb } = await import('./lib/db.mjs');
const ai = await import('./lib/ai.mjs');

const PORT = Number(process.env.PORT) || 3000;
const MAX_CHARS = 120000;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const SOURCES = ['tekst', 'bilde', 'pdf', 'tale'];

const db = openDb(process.env.DB_FILE || path.join(root, 'data', 'saksmappen.db'));
db.purgeOrphans();
setInterval(() => db.purgeOrphans(), 3600_000).unref();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const sendJson = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Forespørselen er for stor.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new HttpError(400, 'Ugyldig JSON.'));
      }
    });
  });
}

const str = (v, max) => String(v ?? '').slice(0, max);

function cleanDoc(b) {
  const text = str(b.text, MAX_CHARS).trim();
  if (!text) throw new HttpError(400, 'Dokumentet har ingen tekst.');
  return {
    title: str(b.title, 200).trim() || 'Uten tittel',
    type: ai.DOC_TYPES.includes(b.type) ? b.type : 'annet',
    date: ai.validDate(b.date) || '',
    received: ai.validDate(b.received) || '',
    text,
    source: SOURCES.includes(b.source) ? b.source : 'tekst',
  };
}

function requireKey() {
  if (!process.env.META_API_KEY) throw new HttpError(500, 'META_API_KEY mangler på serveren.');
}

function caseOr404(token) {
  const c = TOKEN.test(token) && db.getCase(token);
  if (!c) throw new HttpError(404, 'Fant ikke saken. Sjekk lenken.');
  return c;
}

function loadDocs(token) {
  const docs = db.documents(token);
  if (!docs.length) throw new HttpError(400, 'Legg inn minst ett dokument først.');
  if (docs.reduce((n, d) => n + d.text.length, 0) > MAX_CHARS) throw new HttpError(400, 'Saksmappen er for stor for denne versjonen.');
  return docs;
}

function caseView(token) {
  const c = caseOr404(token);
  const docs = db.documents(token);
  const a = db.analysis(token, db.docsHash(docs), ai.PART_KEYS);
  return { case: { token: c.token, name: c.name, person: c.person }, documents: docs, analysis: a.data, analysisState: a.state, checks: db.checks(token) };
}

const icsEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Linjer i iCalendar skal brytes ved 75 byte, ikke 75 tegn.
function icsFold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) {
      out.push(cur);
      cur = ' ' + ch;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}

const ICS_TEXT = {
  nb: { cal: 'Frister: ', deadline: 'Frist: ', case: 'Sak: ', source: 'Kilde: ', quote: 'Sitat: ', check: 'Sjekk alltid fristen mot brevet.', week: 'Frist om en uke', day: 'Frist i morgen' },
  en: { cal: 'Deadlines: ', deadline: 'Deadline: ', case: 'Case: ', source: 'Source: ', quote: 'Quote: ', check: 'Always check the deadline against the letter.', week: 'Deadline in one week', day: 'Deadline tomorrow' },
};

function buildIcs(c, docs, frister, lang) {
  const X = ICS_TEXT[lang];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CaseFolder//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(X.cal + c.name)}`];
  for (const f of frister) {
    const next = new Date(`${f.dato}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const doc = docs.find((x) => x.id === f.dok);
    const uid = crypto.createHash('sha1').update(c.token + f.dato + f.hva).digest('hex').slice(0, 20) + '@saksmappen';
    const desc = [`${X.case}${c.name}`, doc && `${X.source}${doc.title}`, f.sitat && `${X.quote}«${f.sitat}»`, X.check].filter(Boolean).join('\n');
    L.push(
      'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${f.dato.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`,
      `SUMMARY:${icsEsc(X.deadline + f.hva)}`, `DESCRIPTION:${icsEsc(desc)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(X.week)}`, 'TRIGGER:-P7D', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(X.day)}`, 'TRIGGER:-P1D', 'END:VALARM',
      'END:VEVENT',
    );
  }
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}

const PART_FIELDS = { a: ['sammendrag', 'status', 'tidslinje'], b: ['frister', 'neste_steg'], c: ['mangler', 'ordliste'] };

function createSample(lang) {
  const s = JSON.parse(fs.readFileSync(path.join(root, 'samples', `${lang}.json`), 'utf8'));
  const token = db.createCase(s.caseName || (lang === 'nb' ? 'Eksempelsak: Kari' : 'Sample case'), s.person || (lang === 'nb' ? 'Kari Eksempel (fiktiv)' : 'Fictional'));
  const idMap = {};
  for (const d of s.documents) {
    idMap[d.id] = db.addDocument(token, { title: d.title, type: d.type, date: d.date || '', received: '', text: d.text, source: SOURCES.includes(d.source) ? d.source : 'tekst' });
  }
  try {
    const analysis = JSON.parse(fs.readFileSync(path.join(root, 'samples', `${lang}.analysis.json`), 'utf8'));
    for (const k of ['tidslinje', 'frister', 'mangler']) for (const it of analysis[k] || []) it.dok = idMap[it.dok] || it.dok;
    const hash = db.docsHash(db.documents(token));
    for (const [part, fields] of Object.entries(PART_FIELDS)) {
      db.saveAnalysisPart(token, part, Object.fromEntries(fields.filter((f) => f in analysis).map((f) => [f, analysis[f]])), hash);
    }
  } catch {}
  return token;
}

function streamAnalysis(res, token, lang) {
  const docs = loadDocs(token);
  const hash = db.docsHash(docs);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const line = (o) => !res.writableEnded && res.write(JSON.stringify(o) + '\n');
  ai.analyzeParts(docs, (part, data) => {
    db.saveAnalysisPart(token, part, data, hash);
    line({ part, data });
  }, lang)
    .catch((e) => {
      console.error(e.message);
      line({ error: e.message });
    })
    .finally(() => res.end());
}

async function readImages(token, body) {
  requireKey();
  const raw = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  const images = raw.map((u) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(u));
    if (!m) throw new HttpError(400, 'Ugyldig bilde.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 6_000_000) throw new HttpError(413, 'Bildet er for stort.');
    return { mime: m[1], b64: m[2], buf };
  });
  const text = str(body.text, MAX_CHARS);
  // En PDF lagres som original, og sendes til modellen som fil hvis den ikke har tekstlag.
  const pm = typeof body.pdf === 'string' ? /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(body.pdf) : null;
  const pdfBuf = pm ? Buffer.from(pm[1], 'base64') : null;
  if (pdfBuf && pdfBuf.length > 15_000_000) throw new HttpError(413, 'PDF-en er for stor.');
  if (!images.length && !text.trim() && !pdfBuf) throw new HttpError(400, 'Ingenting å lese.');
  const files = images.map((img, i) => db.addFile(token, img.mime, img.buf, i + 1));
  if (pdfBuf) files.push(db.addFile(token, 'application/pdf', pdfBuf, 1));
  const out = await ai.readDocument({ images, text, pdf: pm ? { b64: pm[1] } : null, lang: ai.normLang(body.lang) });
  return { files, ...out };
}

const route = (method, pathname) => {
  const m = pathname.match(/^\/api\/cases(?:\/([^/]+))?(?:\/([a-z.]+))?(?:\/([^/]+))?$/);
  return m ? { method, token: m[1], sub: m[2], id: m[3] } : null;
};

http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'GET' && pathname === '/') return send(res, 200, fs.readFileSync(path.join(root, 'public/index.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === '/api/status') return sendJson(res, { ok: !!process.env.META_API_KEY });

      const r = route(req.method, pathname);
      if (!r) return send(res, 404, 'Ikke funnet', 'text/plain; charset=utf-8');
      const { token, sub, id } = r;

      if (!token) {
        if (req.method !== 'POST') throw new HttpError(405, 'Ikke tillatt.');
        const b = await readBody(req);
        return sendJson(res, { token: db.createCase(str(b.name, 120).trim() || 'Ny sak', str(b.person, 120).trim()) });
      }
      if (token === 'sample' && req.method === 'POST') return sendJson(res, { token: createSample(ai.normLang((await readBody(req)).lang)) });

      caseOr404(token);

      if (!sub) {
        if (req.method === 'GET') return sendJson(res, caseView(token));
        if (req.method === 'PUT') {
          const b = await readBody(req);
          db.updateCase(token, str(b.name, 120).trim() || 'Ny sak', str(b.person, 120).trim());
          return sendJson(res, { ok: true });
        }
        if (req.method === 'DELETE') {
          db.deleteCase(token);
          return sendJson(res, { ok: true });
        }
      }

      if (sub === 'documents') {
        if (req.method === 'POST' && !id) {
          const b = await readBody(req);
          const fileIds = (Array.isArray(b.fileIds) ? b.fileIds : []).map(String).slice(0, 6);
          const docId = db.addDocument(token, cleanDoc(b), fileIds);
          return sendJson(res, { id: docId });
        }
        if (req.method === 'PUT' && id) {
          if (!db.getDocument(token, id)) throw new HttpError(404, 'Fant ikke dokumentet.');
          db.updateDocument(token, id, cleanDoc(await readBody(req)));
          return sendJson(res, { ok: true });
        }
        if (req.method === 'DELETE' && id) {
          db.deleteDocument(token, id);
          return sendJson(res, { ok: true });
        }
      }

      if (sub === 'files' && req.method === 'GET' && id) {
        const f = db.getFile(token, id);
        if (!f) throw new HttpError(404, 'Fant ikke filen.');
        return send(res, 200, f.data, f.mime, { 'Cache-Control': 'private, max-age=3600' });
      }

      if (sub === 'checks' && req.method === 'PUT') {
        const b = await readBody(req);
        const key = str(b.key, 200).trim();
        if (!key) throw new HttpError(400, 'Mangler nøkkel.');
        db.setCheck(token, key, !!b.done);
        return sendJson(res, { ok: true });
      }

      if (sub === 'calendar.ics' && req.method === 'GET') {
        const docs = db.documents(token);
        const frister = (db.analysis(token, db.docsHash(docs), ai.PART_KEYS).data?.frister || []).filter((f) => f.dato).sort((x, y) => x.dato.localeCompare(y.dato));
        const q = new URL(req.url, 'http://x').searchParams, i = q.get('i'), lang = ai.normLang(q.get('lang'));
        const list = i !== null && frister[Number(i)] ? [frister[Number(i)]] : frister;
        if (!list.length) throw new HttpError(404, lang === 'nb' ? 'Ingen frister med dato ennå.' : 'No deadlines with a date yet.');
        return send(res, 200, buildIcs(db.getCase(token), docs, list, lang), 'text/calendar; charset=utf-8', { 'Content-Disposition': `attachment; filename="${lang === 'nb' ? 'saksmappen' : 'casefolder'}-deadlines.ics"` });
      }

      if (sub === 'voice' && req.method === 'POST') {
        requireKey();
        const b = await readBody(req, 30_000_000);
        const wav = typeof b.wav === 'string' ? Buffer.from(b.wav, 'base64') : null;
        if (!wav || wav.length < 1000 || wav.toString('latin1', 0, 4) !== 'RIFF') throw new HttpError(400, 'Ugyldig lydopptak.');
        if (wav.length > 20_000_000) throw new HttpError(413, 'Opptaket er for langt.');
        // Lyden lagres ikke. Bare teksten kommer tilbake, og brukeren velger om den lagres.
        try {
          return sendJson(res, await ai.transcribeWav(wav));
        } catch (e) {
          throw new HttpError(502, e.message);
        }
      }

      if (sub === 'read' && req.method === 'POST') return sendJson(res, await readImages(token, await readBody(req, 25_000_000)));

      if (req.method === 'POST' && ['analyze', 'ask', 'draft'].includes(sub)) {
        requireKey();
        const body = await readBody(req);
        const lang = ai.normLang(body.lang);
        if (sub === 'analyze') return streamAnalysis(res, token, lang);
        const docs = loadDocs(token);
        if (sub === 'ask') return sendJson(res, await ai.ask(docs, str(body.question, 1000), lang));
        return sendJson(res, { tekst: await ai.draft(docs, body.kind, body.docId, lang) });
      }

      throw new HttpError(404, 'Ikke funnet.');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e.message);
      if (res.headersSent) return res.end();
      sendJson(res, { error: e.message }, e.status || 500);
    }
  })
  .listen(PORT, () => console.log(`Saksmappen kjører på http://localhost:${PORT}`));
