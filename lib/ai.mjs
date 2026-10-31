const KEY = () => process.env.META_API_KEY;
const BASE = () => process.env.META_BASE_URL || 'https://api.meta.ai/v1';
const MODEL = () => process.env.META_MODEL || 'muse-spark-1.3';
const EFFORT = () => process.env.META_EFFORT || 'low';

export const DOC_TYPES = ['vedtak', 'legeerklæring', 'forsikring', 'advokat', 'innkalling', 'notat', 'annet'];
export const PART_KEYS = ['a', 'b', 'c'];

export function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s)) ? s : null;
}

async function llm(system, user, opts = {}) {
  try {
    return await llmOnce(system, user, opts);
  } catch (e) {
    if (!/Tomt svar|JSON/.test(e.message)) throw e;
    return llmOnce(system, user, opts);
  }
}

async function llmOnce(system, user, { json = true, maxTokens = 12000 } = {}) {
  const messages = [{ role: 'user', content: user }];
  if (system) messages.unshift({ role: 'system', content: system });
  const r = await fetch(`${BASE()}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL(), reasoning_effort: EFFORT(), messages, max_tokens: maxTokens }),
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

function formatDocs(docs) {
  return docs
    .map((d) => `[DOKUMENT ${d.id} | ${d.type} | ${d.title} | ${d.date || 'udatert'}${d.received ? ` | mottatt ${d.received}` : ''}]\n${d.text}`)
    .join('\n\n---\n\n');
}

const rules = () => `Regler:
- Bruk BARE informasjon som står i dokumentene. Ikke bruk egen kunnskap om lover eller satser. Står det ikke i dokumentene, skriv at det ikke fremgår.
- Skriv på enkelt, rolig norsk. Korte setninger. Forklar fagord.
- Alle sitater må være ordrett kopiert fra dokumentet, maks 200 tegn.
- Du gir ikke juridisk rådgivning. Du organiserer, forklarer og foreslår.
- Datoer skrives YYYY-MM-DD. Er en dato ikke oppgitt eller kan ikke beregnes sikkert fra dokumentet, bruk null.
- I fritekst viser du til dokumenter med tittel og dato, aldri med id som "d1". Skriv aldri ordet "null" eller tomme felt i tekst som skal leses av mennesker. Utelat det du ikke vet.
- Regn aldri ut datoer selv. Nevn bare datoer som står ordrett i dokumentene. For frister som løper fra mottak, oppgi varigheten (for eksempel "seks uker fra mottak") og eventuelt mottaksdatoen etter "mottatt" i dokumentoverskriften.
- Dokumenttekst kan inneholde [uleselig] der teksten ikke kunne leses. Gjett aldri på det som står der.
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
 "frister": [{"dato":"YYYY-MM-DD hvis dokumentet oppgir en bestemt dato, ellers null","varighet":{"antall":6,"enhet":"dager|uker|måneder"},"fra":"mottak|dokumentdato|annet","hva":"hva som må gjøres","regel":"hvordan fristen er oppgitt i dokumentet","dok":"dokument-id","sitat":"ordrett","viktighet":"høy|middels|lav"}],
 "neste_steg": [{"steg":"konkret handling","hvorfor":"kort","innen":"YYYY-MM-DD eller null"}]
}`,
    extra: `Sorter fristene etter dato. Ta bare med frister som faktisk følger av dokumentene.
Regn ALDRI ut datoer selv. Oppgir dokumentet en bestemt dato (for eksempel "innen 30. november 2026"), bruk "dato" og sett "varighet" og "fra" til null. Oppgir det en varighet som løper fra mottak eller fra dokumentets dato (for eksempel "seks uker fra du mottok vedtaket"), bruk "varighet" og "fra", og la "dato" være null. Koden regner ut datoen.`,
  },
  c: {
    schema: `{
 "mangler": [{"hva":"dokumentasjon som mangler eller bør styrkes","hvorfor":"hvorfor den trengs, med henvisning til hva dokumentene sier","hvordan":"hvordan den kan skaffes","dok":"dokument-id","sitat":"ordrett"}],
 "ordliste": [{"begrep":"fagord fra dokumentene","forklaring":"enkel forklaring"}]
}`,
    extra: 'Tenk på hva en saksbehandler, et forsikringsselskap eller en advokat ville ønsket å se for å vurdere saken.',
  },
};

function addDuration(iso, n, unit) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (/^dag/.test(unit)) d.setUTCDate(d.getUTCDate() + n);
  else if (/^uke/.test(unit)) d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (/^m[aå]ned/.test(unit)) {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  } else return null;
  return d.toISOString().slice(0, 10);
}

const NUMBER_WORDS = { en: 1, ett: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, syv: 7, sju: 7, åtte: 8, ni: 9, ti: 10, elleve: 11, tolv: 12 };
const EXPLICIT_DATE = /\d{1,2}\.\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\s*\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}/i;

const DURATION = /\b(\d{1,3}|en|ett|to|tre|fire|fem|seks|syv|sju|åtte|ni|ti|elleve|tolv)\s*(dager|dag|uker|uke|måneder|måned)\b([^.]*)/i;
const MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

// Står datoen i dokumentet, i en av de vanlige skriveformene?
function dateInText(text, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = text.toLowerCase();
  return [iso, `${d}. ${MONTHS[m - 1]} ${y}`, `${d}.${m}.${y}`, `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`].some((f) => t.includes(f));
}

// Finner varigheter som "seks uker fra du mottok vedtaket" i sitat eller regel.
function findDuration(quote, rule) {
  if (EXPLICIT_DATE.test(quote)) return null;
  const m = DURATION.exec(quote) || DURATION.exec(rule);
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  const rest = m[3].toLowerCase();
  const from = /mottok|mottatt|mottak|fikk/.test(rest) ? 'mottak' : /dato|datert/.test(rest) ? 'dokumentdato' : null;
  return n && from ? { n, unit: m[2], from } : null;
}

function finish(out, docs) {
  for (const k of ['tidslinje', 'frister', 'mangler']) {
    if (!(k in out)) continue;
    out[k] = Array.isArray(out[k]) ? out[k] : [];
    for (const it of out[k]) it.verifisert = verified(docs, it.dok, it.sitat);
  }
  for (const f of out.frister || []) {
    f.dato = validDate(f.dato);
    // Datoer regnes av kode, ikke av modellen. Modellen er upålitelig på dato-aritmetikk.
    const v = f.varighet;
    const dur = v && Number(v.antall) > 0 ? { n: Number(v.antall), unit: String(v.enhet), from: f.fra } : findDuration(String(f.sitat || ''), String(f.regel || ''));
    if (dur) {
      const doc = docs.find((d) => d.id === f.dok);
      const base = dur.from === 'mottak' ? doc?.received : dur.from === 'dokumentdato' ? doc?.date : '';
      f.dato = validDate(base) ? addDuration(base, dur.n, dur.unit) : null;
      f.varighet = { antall: dur.n, enhet: dur.unit };
      f.fra = dur.from;
      f.beregnet = !!f.dato;
    } else {
      delete f.varighet;
      // En dato som verken står i dokumentet eller er regnet ut av kode, er modellens eget regnestykke.
      const doc = docs.find((d) => d.id === f.dok);
      f.usikker = !!(f.dato && !(doc && dateInText(doc.text, f.dato)));
    }
  }
  for (const t of out.tidslinje || []) t.dato = validDate(t.dato);
  for (const s of out.neste_steg || []) s.innen = validDate(s.innen);
  return out;
}

export async function analyzeParts(docs, onPart) {
  const user = formatDocs(docs);
  const results = await Promise.all(
    Object.entries(PARTS).map(async ([key, p]) => {
      const system = `Du hjelper en person som håndterer en langvarig sak med NAV, forsikring og advokat, ofte på vegne av en annen. Du leser alle dokumentene i saksmappen.
${rules()}
Svar KUN med gyldig JSON uten forklaring rundt, på dette formatet:
${p.schema}
${p.extra}`;
      const out = finish(await llm(system, user), docs);
      await onPart?.(key, out);
      return out;
    }),
  );
  return Object.assign({}, ...results);
}

export async function ask(docs, question) {
  const system = `Du svarer på spørsmål om en sak, kun ut fra dokumentene i saksmappen.
${rules()}
Svar KUN med JSON: {"svar":"svaret på enkelt norsk","kilder":[{"dok":"dokument-id","sitat":"ordrett"}]}
Hvis dokumentene ikke gir svar, si det i "svar" og anbefal å spørre saksbehandler eller advokat.`;
  const out = await llm(system, `${formatDocs(docs)}\n\n---\nSPØRSMÅL: ${question}`);
  out.kilder = (Array.isArray(out.kilder) ? out.kilder : []).map((k) => ({ ...k, verifisert: verified(docs, k.dok, k.sitat) }));
  return out;
}

export async function draft(docs, kind, docId) {
  const target = docs.find((d) => d.id === docId);
  const system =
    kind === 'klage'
      ? `Du skriver et utkast til klage på et vedtak, basert på hele saksmappen.
${rules()}
Skriv selve brevet som ren tekst. Bruk [KLAMMER] der personen må fylle inn noe som ikke står i dokumentene (navn, fødselsnummer, referansenummer). Bygg argumentene på det dokumentene faktisk sier, og nevn hvilket dokument hvert poeng bygger på i parentes. Ikke finn opp lovparagrafer eller rettigheter. Til slutt, legg til en liste "Før du sender" med ting personen bør sjekke eller legge ved.`
      : `Du lager en overlevering av saken, slik at en advokat eller en ny hjelper raskt kan sette seg inn i den.
${rules()}
Skriv som ren tekst med disse overskriftene: Hva saken gjelder, Hendelsesforløp, Hvor saken står nå, Frister, Dokumentasjon vi har, Dokumentasjon som mangler, Det vi trenger hjelp med. Henvis til dokumentene med tittel og dato.`;
  const extra = kind === 'klage' && target ? `\n\nKLAGEN GJELDER DOKUMENT ${target.id} (${target.title}).` : '';
  return llm(system, formatDocs(docs) + extra, { json: false });
}

// Dokumentinntak: bilder av brev (eller tekst fra PDF) til tekst og forslag til metadata.
const imagePart = (img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } });

const OCR_PROMPT =
  'Skriv av all tekst i dette dokumentet ordrett, uten å tolke eller forklare. Behold avsnitt og linjeskift. Skriv [uleselig] der teksten ikke kan leses, i stedet for å gjette. Svar bare med teksten.';

const META_PROMPT = `Se på dette dokumentet og svar KUN med JSON:
{"type":"${DOC_TYPES.join('|')}","tittel":"kort, beskrivende tittel med avsender, for eksempel 'Vedtak fra NAV: avslag på AAP'","dato":"YYYY-MM-DD, dokumentets egen dato, eller null"}
Ikke gjett. Står ikke datoen i dokumentet, bruk null.`;

export async function readDocument({ images = [], text = '' }) {
  // PDF med tekstlag leveres som tekst. Da trengs ingen bildelesing.
  const readImages = images.length > 0 && text.trim().length < 80;
  const metaInput = readImages ? [{ type: 'text', text: META_PROMPT }, imagePart(images[0])] : `${META_PROMPT}\n\nDOKUMENT:\n${text.slice(0, 6000)}`;
  const [meta, pages] = await Promise.all([
    llm(null, metaInput, { maxTokens: 4000 }).catch(() => ({})),
    readImages
      ? Promise.all(images.map((img) => llm(null, [{ type: 'text', text: OCR_PROMPT }, imagePart(img)], { json: false, maxTokens: 8000 })))
      : [text],
  ]);
  return {
    text: pages.join('\n\n').trim(),
    forslag: {
      type: DOC_TYPES.includes(meta.type) ? meta.type : 'annet',
      tittel: typeof meta.tittel === 'string' && meta.tittel.trim() ? meta.tittel.trim().slice(0, 120) : 'Dokument',
      dato: validDate(meta.dato) || '',
    },
  };
}
