// The whole API as one web-standard handler: (Request) => Response.
// The local Node server and the Netlify function both call it, each with its own store.
import crypto from 'node:crypto';
import * as ai from './ai.mjs';
import { mergeFacts, applyPatch, factViews, packetHtml, packetJson } from './facts.mjs';
import sampleEn from '../samples/en.json' with { type: 'json' };
import sampleNb from '../samples/nb.json' with { type: 'json' };
import analysisEn from '../samples/en.analysis.json' with { type: 'json' };
import analysisNb from '../samples/nb.analysis.json' with { type: 'json' };

const SAMPLES = { en: [sampleEn, analysisEn], nb: [sampleNb, analysisNb] };
const MAX_CHARS = 120000;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const SOURCES = ['tekst', 'bilde', 'pdf', 'tale'];
const GATED = ['analyze', 'ask', 'draft', 'read', 'voice', 'translate'];
const PART_FIELDS = { a: ['sammendrag', 'status', 'tidslinje'], b: ['frister', 'neste_steg'], c: ['mangler', 'ordliste'], d: ['ideer'], e: ['fakta'] };

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
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

const icsEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// iCalendar lines fold at 75 bytes, not 75 characters.
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
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CaseAlly//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(X.cal + c.name)}`];
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

const sameCode = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * store: async-or-sync storage (see lib/db.mjs and lib/blobstore.mjs)
 * opts.hosted: public deployment. Turns on the access code, the usage caps and the smaller upload limits.
 * opts.env: environment variables (defaults to process.env)
 */
export function createHandler(store, opts = {}) {
  const env = opts.env || process.env;
  const hosted = !!opts.hosted;
  const accessCode = env.ACCESS_CODE || '';
  const hasKey = () => !!(env.CASEALLY_API_KEY || env.META_API_KEY);
  const dailyCap = Number(env.DAILY_CAP) || 400;
  const hourlyPerIp = Number(env.HOURLY_PER_IP) || 60;
  const casesPerIpDay = Number(env.CASES_PER_IP_DAY) || 40;
  // Netlify buffers a request up to 6 MB. Leave room for the JSON around the file.
  const bodyLimit = hosted ? 5_500_000 : 30_000_000;
  const limits = { upload: bodyLimit, pdf: hosted ? 3_500_000 : 14_000_000, voiceSec: hosted ? 80 : 300 };

  async function readBody(req, limit = 2_000_000) {
    const max = Math.min(limit, bodyLimit);
    const declared = Number(req.headers.get('content-length') || 0);
    const tooBig = () => new HttpError(413, hosted ? 'That file is too large for the online version. Try a smaller photo or a shorter recording.' : 'Forespørselen er for stor.');
    if (declared > max) throw tooBig();
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > max) throw tooBig();
    try {
      return JSON.parse(buf.toString() || '{}');
    } catch {
      throw new HttpError(400, 'Ugyldig JSON.');
    }
  }

  function requireKey() {
    if (!hasKey()) throw new HttpError(500, 'META_API_KEY mangler på serveren.');
  }

  async function guardAi(req, ip) {
    if (!hosted) return;
    if (accessCode && !sameCode(req.headers.get('x-access-code') || '', accessCode)) {
      throw new HttpError(401, 'Live AI needs an access code. The fictional sample cases work without one.', { code: 'access' });
    }
    const day = new Date().toISOString().slice(0, 10), hour = new Date().toISOString().slice(0, 13);
    const ipKey = crypto.createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 16);
    if ((await store.bump(`ai-day-${day}`)) > dailyCap) throw new HttpError(429, 'The daily limit for live AI has been reached. Try again tomorrow, or use the sample cases.', { code: 'cap' });
    if ((await store.bump(`ai-ip-${ipKey}-${hour}`)) > hourlyPerIp) throw new HttpError(429, 'Too many requests from your network this hour. Try again later.', { code: 'cap' });
  }

  // Facts live in their own list. An analysis that reads facts replaces the extracted ones and keeps what the user did.
  async function syncFacts(token, extracted) {
    if (!Array.isArray(extracted)) return;
    await store.putFacts(token, mergeFacts(await store.getFacts(token), extracted, token));
  }

  async function caseOr404(token) {
    const c = TOKEN.test(token) && (await store.getCase(token));
    if (!c) throw new HttpError(404, 'Fant ikke saken. Sjekk lenken.');
    return c;
  }

  async function loadDocs(token) {
    const docs = await store.documents(token);
    if (!docs.length) throw new HttpError(400, 'Legg inn minst ett dokument først.');
    if (docs.reduce((n, d) => n + d.text.length, 0) > MAX_CHARS) throw new HttpError(400, 'Saksmappen er for stor for denne versjonen.');
    return docs;
  }

  async function createSample(lang) {
    const [s, analysis] = SAMPLES[lang];
    const token = await store.createCase(s.caseName || (lang === 'nb' ? 'Eksempelsak: Kari' : 'Sample case'), s.person || (lang === 'nb' ? 'Kari Eksempel (fiktiv)' : 'Fictional'));
    const idMap = {};
    for (const d of s.documents) {
      idMap[d.id] = await store.addDocument(token, { title: d.title, type: d.type, date: d.date || '', received: '', text: d.text, source: SOURCES.includes(d.source) ? d.source : 'tekst' });
    }
    const a = structuredClone(analysis);
    for (const k of ['tidslinje', 'frister', 'mangler']) for (const it of a[k] || []) it.dok = idMap[it.dok] || it.dok;
    const hash = store.docsHash(await store.documents(token));
    for (const f of a.fakta || []) f.dok = idMap[f.dok] || f.dok;
    for (const [part, fields] of Object.entries(PART_FIELDS)) {
      await store.saveAnalysisPart(token, part, Object.fromEntries(fields.filter((f) => f in a).map((f) => [f, a[f]])), hash);
    }
    await syncFacts(token, a.fakta);
    return token;
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
    const pm = typeof body.pdf === 'string' ? /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(body.pdf) : null;
    const pdfBuf = pm ? Buffer.from(pm[1], 'base64') : null;
    if (pdfBuf && pdfBuf.length > limits.pdf + 1_000_000) throw new HttpError(413, 'PDF-en er for stor.');
    if (!images.length && !text.trim() && !pdfBuf) throw new HttpError(400, 'Ingenting å lese.');
    const files = [];
    for (const [i, img] of images.entries()) files.push(await store.addFile(token, img.mime, img.buf, i + 1));
    if (pdfBuf) files.push(await store.addFile(token, 'application/pdf', pdfBuf, 1));
    const out = await ai.readDocument({ images, text, pdf: pm ? { b64: pm[1] } : null, lang: ai.normLang(body.lang) });
    return { files, ...out };
  }

  function streamAnalysis(docs, token, lang) {
    const hash = store.docsHash(docs);
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async start(ctl) {
        const line = (o) => { try { ctl.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch {} };
        const saves = [];
        try {
          await ai.analyzeParts(docs, (part, data) => {
            saves.push(Promise.resolve(store.saveAnalysisPart(token, part, data, hash)).catch((e) => console.error(e.message)));
            if (part === 'e') saves.push(syncFacts(token, data.fakta).catch((e) => console.error(e.message)));
            line({ part, data });
          }, lang, (part) => line({ partError: part }));
        } catch (e) {
          console.error(e.message);
          line({ error: e.message });
        }
        await Promise.all(saves);
        try { ctl.close(); } catch {}
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  return async function handle(req, { ip = '' } = {}) {
    try {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

      if (method === 'GET' && pathname === '/api/status') {
        return json({ ok: hasKey(), hosted, needsCode: hosted && !!accessCode, limits });
      }
      if (method === 'POST' && pathname === '/api/access') {
        const b = await readBody(req);
        if (!hosted || !accessCode || sameCode(b.code ?? '', accessCode)) return json({ ok: true });
        throw new HttpError(401, 'That access code is not right.', { code: 'access' });
      }

      const m = pathname.match(/^\/api\/cases(?:\/([^/]+))?(?:\/([a-z.]+))?(?:\/([^/]+))?$/);
      if (!m) return new Response('Ikke funnet', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const [, token, sub, id] = m;

      if (!token || token === 'sample') {
        if (method !== 'POST') throw new HttpError(405, 'Ikke tillatt.');
        if (hosted) {
          const day = new Date().toISOString().slice(0, 10), k = crypto.createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 16);
          if ((await store.bump(`case-ip-${k}-${day}`)) > casesPerIpDay) throw new HttpError(429, 'Too many cases created from your network today.', { code: 'cap' });
        }
        const b = await readBody(req);
        if (!token) return json({ token: await store.createCase(str(b.name, 120).trim() || 'Ny sak', str(b.person, 120).trim()) });
        return json({ token: await createSample(ai.normLang(b.lang)) });
      }

      await caseOr404(token);

      if (!sub) {
        if (method === 'GET') {
          const c = await store.getCase(token);
          const docs = await store.documents(token);
          const a = await store.analysis(token, store.docsHash(docs), ai.PART_KEYS);
          return json({ case: { token: c.token, name: c.name, person: c.person }, documents: docs, analysis: a.data, analysisState: a.state, checks: await store.checks(token), facts: factViews(await store.getFacts(token), docs) });
        }
        if (method === 'PUT') {
          const b = await readBody(req);
          await store.updateCase(token, str(b.name, 120).trim() || 'Ny sak', str(b.person, 120).trim());
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          await store.deleteCase(token);
          return json({ ok: true });
        }
      }

      if (sub === 'documents') {
        if (method === 'POST' && !id) {
          const b = await readBody(req);
          const fileIds = (Array.isArray(b.fileIds) ? b.fileIds : []).map(String).slice(0, 6);
          return json({ id: await store.addDocument(token, cleanDoc(b), fileIds) });
        }
        if (method === 'PUT' && id) {
          if (!(await store.getDocument(token, id))) throw new HttpError(404, 'Fant ikke dokumentet.');
          await store.updateDocument(token, id, cleanDoc(await readBody(req)));
          return json({ ok: true });
        }
        if (method === 'DELETE' && id) {
          await store.deleteDocument(token, id);
          return json({ ok: true });
        }
      }

      if (sub === 'facts') {
        const rows = await store.getFacts(token);
        if (method === 'GET' && !id) return json({ facts: factViews(rows, await store.documents(token)) });
        const row = id && rows.find((r) => r.id === id);
        if (id && !row) throw new HttpError(404, 'Fant ikke faktaen.');
        if (method === 'DELETE' && id) {
          await store.putFacts(token, rows.filter((r) => r.id !== id));
          return json({ ok: true });
        }
        if (method === 'PUT' && id) {
          const b = await readBody(req), patch = {};
          if ('confirmed' in b) patch.confirmed = !!b.confirmed;
          if ('included' in b) patch.included = !!b.included;
          if ('value' in b) patch.value = b.value;
          if ('validDuration' in b) patch.validDuration = b.validDuration;
          let next;
          try {
            next = applyPatch(row, patch);
          } catch (e) {
            throw new HttpError(400, e.code === 'duration' ? 'Write the duration like “6 months”.' : 'The value cannot be empty.');
          }
          await store.putFacts(token, rows.map((r) => (r.id === id ? next : r)));
          return json({ fact: factViews([next], await store.documents(token))[0] });
        }
      }

      if ((sub === 'packet' || sub === 'packet.json') && method === 'GET') {
        const q = url.searchParams, lang = ai.normLang(q.get('lang'));
        const o = { lang, hide: q.get('hide') !== '0', quotes: q.get('quotes') === '1' };
        const c = await store.getCase(token), rows = await store.getFacts(token), docs = await store.documents(token);
        if (sub === 'packet.json') {
          return new Response(JSON.stringify(packetJson(c, rows, docs, o), null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(q.get('dl') === '1' ? { 'Content-Disposition': 'attachment; filename="case-ally-proof-packet.json"' } : {}) },
          });
        }
        return new Response(packetHtml(c, rows, docs, o), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' },
        });
      }

      if (sub === 'files' && method === 'GET' && id) {
        const f = await store.getFile(token, id);
        if (!f) throw new HttpError(404, 'Fant ikke filen.');
        return new Response(f.data, { headers: { 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=3600' } });
      }

      if (sub === 'checks' && method === 'PUT') {
        const b = await readBody(req);
        const key = str(b.key, 200).trim();
        if (!key) throw new HttpError(400, 'Mangler nøkkel.');
        await store.setCheck(token, key, !!b.done);
        return json({ ok: true });
      }

      if (sub === 'calendar.ics' && method === 'GET') {
        const docs = await store.documents(token);
        const frister = ((await store.analysis(token, store.docsHash(docs), ai.PART_KEYS)).data?.frister || []).filter((f) => f.dato).sort((x, y) => x.dato.localeCompare(y.dato));
        const i = url.searchParams.get('i'), lang = ai.normLang(url.searchParams.get('lang'));
        const list = i !== null && frister[Number(i)] ? [frister[Number(i)]] : frister;
        if (!list.length) throw new HttpError(404, lang === 'nb' ? 'Ingen frister med dato ennå.' : 'No deadlines with a date yet.');
        return new Response(buildIcs(await store.getCase(token), docs, list, lang), {
          headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${lang === 'nb' ? 'saksmappen' : 'case-ally'}-deadlines.ics"` },
        });
      }

      if (method === 'POST' && GATED.includes(sub)) {
        // Cheap checks first, so a bad request never spends the budget.
        requireKey();
        if (sub === 'voice') {
          const b = await readBody(req, 30_000_000);
          const wav = typeof b.wav === 'string' ? Buffer.from(b.wav, 'base64') : null;
          if (!wav || wav.length < 1000 || wav.toString('latin1', 0, 4) !== 'RIFF') throw new HttpError(400, 'Ugyldig lydopptak.');
          if (wav.length > 20_000_000) throw new HttpError(413, 'Opptaket er for langt.');
          await guardAi(req, ip);
          // The audio is not stored. Only the text comes back, and the user chooses whether to save it.
          try {
            return json(await ai.transcribeWav(wav));
          } catch (e) {
            throw new HttpError(502, e.message);
          }
        }
        if (sub === 'read') {
          const b = await readBody(req, 25_000_000);
          await guardAi(req, ip);
          return json(await readImages(token, b));
        }
        if (sub === 'translate') {
          const b = await readBody(req);
          if (!ai.TARGET_LANGS[b.lang]) throw new HttpError(400, 'Unsupported language.');
          await guardAi(req, ip);
          const p = b.parts || {}, s = (v) => str(v, 2500);
          const parts = { headings: { h1: s(p.headings?.h1), h2: s(p.headings?.h2), h3: s(p.headings?.h3) }, happened: s(p.happened), now: s(p.now), todo: (Array.isArray(p.todo) ? p.todo : []).slice(0, 8).map(s) };
          try {
            return json(await ai.translateSimple(parts, b.lang));
          } catch (e) {
            throw new HttpError(502, e.message);
          }
        }
        const b = await readBody(req);
        const lang = ai.normLang(b.lang);
        const docs = await loadDocs(token);
        await guardAi(req, ip);
        if (sub === 'analyze') return streamAnalysis(docs, token, lang);
        if (sub === 'ask') return json(await ai.ask(docs, str(b.question, 1000), lang));
        return json({ tekst: await ai.draft(docs, b.kind, b.docId, lang) });
      }

      throw new HttpError(404, 'Ikke funnet.');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e.message);
      return json({ error: e.message, ...(e.extra || {}) }, e.status || 500);
    }
  };
}
