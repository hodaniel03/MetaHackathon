import http from 'node:http';
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

const KEY = process.env.META_API_KEY;
const BASE = process.env.META_BASE_URL || 'https://api.meta.ai/v1';
const MODEL = process.env.META_MODEL || 'muse-spark-1.3';
const EFFORT = process.env.META_EFFORT || 'low';
const PORT = Number(process.env.PORT) || 3000;
const MAX_CHARS = 120000;

async function llm(system, user, opts = {}) {
  try {
    return await llmOnce(system, user, opts);
  } catch (e) {
    if (!/Tomt svar|JSON/.test(e.message)) throw e;
    return llmOnce(system, user, opts);
  }
}

async function llmOnce(system, user, { json = true, maxTokens = 12000 } = {}) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: EFFORT,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(150000),
  });
  if (!r.ok) throw new Error(`Meta API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = (await r.json()).choices?.[0]?.message?.content;
  if (!text) throw new Error('Tomt svar fra modellen. Prøv igjen.');
  return json ? parseJson(text) : text.trim();
}

function parseJson(text) {
  const s = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’“”"'«»]/g, '').replace(/\s+/g, ' ').trim();

function verified(docs, id, quote) {
  const d = docs.find((x) => x.id === id);
  return !!(d && quote && norm(d.text).includes(norm(quote)));
}

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s)) ? s : null;
}

function formatDocs(docs) {
  return docs
    .map((d) => `[DOKUMENT ${d.id} | ${d.type} | ${d.title} | ${d.date || 'udatert'}${d.received ? ` | mottatt ${d.received}` : ''}]\n${d.text}`)
    .join('\n\n---\n\n');
}

const RULES = `Regler:
- Bruk BARE informasjon som står i dokumentene. Ikke bruk egen kunnskap om lover eller satser. Står det ikke i dokumentene, skriv at det ikke fremgår.
- Skriv på enkelt, rolig norsk. Korte setninger. Forklar fagord.
- Alle sitater må være ordrett kopiert fra dokumentet, maks 200 tegn.
- Du gir ikke juridisk rådgivning. Du organiserer, forklarer og foreslår.
- Datoer skrives YYYY-MM-DD. Er en dato ikke oppgitt eller kan ikke beregnes sikkert fra dokumentet, bruk null.
- I fritekst viser du til dokumenter med tittel og dato, aldri med id som "d1". Skriv aldri ordet "null" eller tomme felt i tekst som skal leses av mennesker. Utelat det du ikke vet.
- Frister som løper fra mottak beregnes fra datoen etter "mottatt" i dokumentoverskriften. Står ingen mottaksdato der, sett dato til null og skriv i "regel" hvor mange uker eller dager fristen er.
- Dagens dato er ${new Date().toISOString().slice(0, 10)}.`;

// Analysen deles i tre uavhengige kall som kjører samtidig.
const PARTS = {
  a: {
    schema: `{
 "sammendrag": "3-5 setninger: hva saken handler om og hva som har skjedd",
 "status": "1-2 setninger: hvor saken står nå",
 "tidslinje": [{"dato":"YYYY-MM-DD","tittel":"kort","beskrivelse":"1-2 setninger","dok":"dokument-id","sitat":"ordrett"}]
}`,
    extra: 'Sorter tidslinjen kronologisk.',
  },
  b: {
    schema: `{
 "frister": [{"dato":"YYYY-MM-DD eller null","hva":"hva som må gjøres","regel":"hvordan fristen er oppgitt i dokumentet","dok":"dokument-id","sitat":"ordrett","viktighet":"høy|middels|lav"}],
 "neste_steg": [{"steg":"konkret handling","hvorfor":"kort","innen":"YYYY-MM-DD eller null"}]
}`,
    extra: 'Sorter fristene etter dato. Ta bare med frister som faktisk følger av dokumentene.',
  },
  c: {
    schema: `{
 "mangler": [{"hva":"dokumentasjon som mangler eller bør styrkes","hvorfor":"hvorfor den trengs, med henvisning til hva dokumentene sier","hvordan":"hvordan den kan skaffes","dok":"dokument-id","sitat":"ordrett"}],
 "ordliste": [{"begrep":"fagord fra dokumentene","forklaring":"enkel forklaring"}]
}`,
    extra: 'Tenk på hva en saksbehandler, et forsikringsselskap eller en advokat ville ønsket å se for å vurdere saken.',
  },
};

function finish(out, docs) {
  for (const k of ['tidslinje', 'frister', 'mangler']) {
    if (!(k in out)) continue;
    out[k] = Array.isArray(out[k]) ? out[k] : [];
    for (const it of out[k]) it.verifisert = verified(docs, it.dok, it.sitat);
  }
  for (const f of out.frister || []) f.dato = validDate(f.dato);
  for (const t of out.tidslinje || []) t.dato = validDate(t.dato);
  for (const s of out.neste_steg || []) s.innen = validDate(s.innen);
  return out;
}

async function analyzeParts(docs, onPart) {
  const user = formatDocs(docs);
  const results = await Promise.all(
    Object.entries(PARTS).map(async ([key, p]) => {
      const system = `Du hjelper en person som håndterer en langvarig sak med NAV, forsikring og advokat, ofte på vegne av en annen. Du leser alle dokumentene i saksmappen.
${RULES}
Svar KUN med gyldig JSON uten forklaring rundt, på dette formatet:
${p.schema}
${p.extra}`;
      const out = finish(await llm(system, user), docs);
      onPart?.(key, out);
      return out;
    }),
  );
  return Object.assign({}, ...results);
}

async function ask(docs, question) {
  const system = `Du svarer på spørsmål om en sak, kun ut fra dokumentene i saksmappen.
${RULES}
Svar KUN med JSON: {"svar":"svaret på enkelt norsk","kilder":[{"dok":"dokument-id","sitat":"ordrett"}]}
Hvis dokumentene ikke gir svar, si det i "svar" og anbefal å spørre saksbehandler eller advokat.`;
  const out = await llm(system, `${formatDocs(docs)}\n\n---\nSPØRSMÅL: ${question}`);
  out.kilder = (Array.isArray(out.kilder) ? out.kilder : []).map((k) => ({ ...k, verifisert: verified(docs, k.dok, k.sitat) }));
  return out;
}

async function draft(docs, kind, docId) {
  const target = docs.find((d) => d.id === docId);
  const system =
    kind === 'klage'
      ? `Du skriver et utkast til klage på et vedtak, basert på hele saksmappen.
${RULES}
Skriv selve brevet som ren tekst. Bruk [KLAMMER] der personen må fylle inn noe som ikke står i dokumentene (navn, fødselsnummer, referansenummer). Bygg argumentene på det dokumentene faktisk sier, og nevn hvilket dokument hvert poeng bygger på i parentes. Ikke finn opp lovparagrafer eller rettigheter. Til slutt, legg til en liste "Før du sender" med ting personen bør sjekke eller legge ved.`
      : `Du lager en overlevering av saken, slik at en advokat eller en ny hjelper raskt kan sette seg inn i den.
${RULES}
Skriv som ren tekst med disse overskriftene: Hva saken gjelder, Hendelsesforløp, Hvor saken står nå, Frister, Dokumentasjon vi har, Dokumentasjon som mangler, Det vi trenger hjelp med. Henvis til dokumentene med tittel og dato.`;
  const extra = kind === 'klage' && target ? `\n\nKLAGEN GJELDER DOKUMENT ${target.id} (${target.title}).` : '';
  return llm(system, formatDocs(docs) + extra, { json: false });
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('For stor forespørsel'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new Error('Ugyldig JSON'));
      }
    });
  });
}

function cleanDocs(body) {
  const docs = (Array.isArray(body.documents) ? body.documents : [])
    .map((d) => ({ id: String(d.id), title: String(d.title || 'Uten tittel'), type: String(d.type || 'annet'), date: d.date || '', received: validDate(d.received) || '', text: String(d.text || '') }))
    .filter((d) => d.text.trim());
  if (!docs.length) throw new Error('Legg inn minst ett dokument først.');
  if (docs.reduce((n, d) => n + d.text.length, 0) > MAX_CHARS) throw new Error('Saksmappen er for stor for denne versjonen.');
  return docs;
}

function sample() {
  const s = JSON.parse(fs.readFileSync(path.join(root, 'sample.json'), 'utf8'));
  try {
    s.analysis = JSON.parse(fs.readFileSync(path.join(root, 'sample-analysis.json'), 'utf8'));
  } catch {}
  return s;
}

function streamAnalysis(res, docs) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const line = (o) => !res.writableEnded && res.write(JSON.stringify(o) + '\n');
  analyzeParts(docs, (part, data) => line({ part, data }))
    .catch((e) => {
      console.error(e.message);
      line({ error: e.message });
    })
    .finally(() => res.end());
}

http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'GET' && pathname === '/') return send(res, 200, fs.readFileSync(path.join(root, 'public/index.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === '/api/sample') return sendJson(res, sample());
      if (req.method === 'GET' && pathname === '/api/status') return sendJson(res, { ok: !!KEY, model: MODEL, effort: EFFORT });
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        if (!KEY) return sendJson(res, { error: 'META_API_KEY mangler på serveren.' }, 500);
        const body = await readBody(req);
        const docs = cleanDocs(body);
        if (pathname === '/api/analyze-stream') return streamAnalysis(res, docs);
        if (pathname === '/api/analyze') return sendJson(res, await analyzeParts(docs));
        if (pathname === '/api/ask') return sendJson(res, await ask(docs, String(body.question || '').slice(0, 1000)));
        if (pathname === '/api/draft') return sendJson(res, { tekst: await draft(docs, body.kind, body.docId) });
      }
      send(res, 404, 'Ikke funnet', 'text/plain; charset=utf-8');
    } catch (e) {
      console.error(e.message);
      sendJson(res, { error: e.message }, 500);
    }
  })
  .listen(PORT, () => console.log(`Saksmappen kjører på http://localhost:${PORT} (modell ${MODEL}, effort ${EFFORT})`));
