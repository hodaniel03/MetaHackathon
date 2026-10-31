const KEY = () => process.env.META_API_KEY;
const BASE = () => process.env.META_BASE_URL || 'https://api.meta.ai/v1';
const MODEL = () => process.env.META_MODEL || 'muse-spark-1.3';
const EFFORT = () => process.env.META_EFFORT || 'low';

// Interne verdier (dokumenttyper og JSON-nøkler) er norske i begge språk. Bare teksten modellen ser og skriver er oversatt.
export const DOC_TYPES = ['vedtak', 'legeerklæring', 'forsikring', 'advokat', 'innkalling', 'notat', 'annet'];
export const PART_KEYS = ['a', 'b', 'c'];
export const LANGS = ['en', 'nb'];
export const normLang = (l) => (l === 'nb' ? 'nb' : 'en');

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

function formatDocs(docs, lang) {
  const [undated, got, voice] = lang === 'nb' ? ['udatert', 'mottatt', 'talenotat'] : ['undated', 'received', 'voice note'];
  return docs
    .map((d) => `[DOKUMENT ${d.id} | ${d.type} | ${d.title} | ${d.date || undated}${d.received ? ` | ${got} ${d.received}` : ''}${d.source === 'tale' ? ` | ${voice}` : ''}]\n${d.text}`)
    .join('\n\n---\n\n');
}

const today = () => new Date().toISOString().slice(0, 10);

const RULES = {
  nb: () => `Regler:
- Bruk BARE informasjon som står i dokumentene. Ikke bruk egen kunnskap om lover eller satser. Står det ikke i dokumentene, skriv at det ikke fremgår.
- Skriv på enkelt, rolig norsk. Korte setninger. Forklar fagord.
- Alle sitater må være ordrett kopiert fra dokumentet, maks 200 tegn.
- Du gir ikke juridisk rådgivning. Du organiserer, forklarer og foreslår.
- I JSON-feltene "dato" og "innen" skrives datoer YYYY-MM-DD. I all fritekst skriver du datoer på norsk, for eksempel «18. november 2026». Er en dato ikke oppgitt eller kan ikke beregnes sikkert fra dokumentet, bruk null.
- I fritekst viser du til et dokument med tittelen i anførselstegn, for eksempel «Mitt notat» (25. oktober 2026), aldri med id som "d1". Skriv aldri ordet "null" eller tomme felt i tekst som skal leses av mennesker. Utelat det du ikke vet.
- Regn aldri ut datoer selv. Nevn bare datoer som står ordrett i dokumentene. For frister som løper fra mottak, oppgi varigheten (for eksempel "seks uker fra mottak") og eventuelt mottaksdatoen etter "mottatt" i dokumentoverskriften.
- Dokumenttekst kan inneholde [uleselig] der teksten ikke kunne leses. Gjett aldri på det som står der.
- Et dokument merket «talenotat» er brukerens egen muntlige beretning, ikke et offisielt dokument. Behandle det som det brukeren sier, aldri som et vedtak eller en uttalelse fra en etat eller et forsikringsselskap. Ta likevel med frister, hendelser og manglende ting brukeren nevner der, og skriv i «regel» eller «hvorfor» at det kommer fra brukerens egen beretning og bør bekreftes skriftlig.
- Dagens dato er ${today()}.`,
  en: () => `Rules:
- Use ONLY information that appears in the documents. Do not use your own knowledge of laws or rates. If something is not in the documents, say that it does not appear.
- Write in plain, calm English. Short sentences. Explain technical terms.
- Every quote must be copied word for word from the document, at most 200 characters.
- You do not give legal advice. You organize, explain and suggest.
- In the JSON fields "dato" and "innen", write dates as YYYY-MM-DD. In all free text, write dates in plain English, for example "November 18, 2026". If a date is not stated or cannot be computed safely from the document, use null.
- In free text, refer to a document by its title in quotation marks, for example “My note” (October 25, 2026), never by an id like "d1" and never with “the” in front of the title. Never write the word "null" or empty fields in text meant for people. Leave out what you do not know.
- Never calculate dates yourself. Mention only dates that appear word for word in the documents. For deadlines that run from receipt, state the duration (for example "60 days from receipt") and, if present, the received date after "received" in the document header.
- Document text may contain [illegible] where the text could not be read. Never guess what is there.
- A document marked “voice note” is the user's own spoken account, not an official document. Treat it as what the user says, never as a decision or a statement from an agency or insurer. Still include deadlines, events and missing items the user mentions in it, and say in "regel" or "hvorfor" that it comes from the user's own account and should be confirmed in writing.
- Today's date is ${today()}.`,
};

const INTRO = {
  nb: 'Du hjelper en person som håndterer en langvarig sak med NAV, forsikring og advokat, ofte på vegne av en annen. Du leser alle dokumentene i saksmappen.',
  en: 'You help a person who is handling a long-running case with a government agency, an insurer and a lawyer, often on behalf of someone else. You read every document in the case folder.',
};

// Analysen deles i tre uavhengige kall som kjører samtidig. JSON-nøklene er interne og like i begge språk.
const PARTS = {
  nb: {
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
 "frister": [{"dato":"YYYY-MM-DD hvis dokumentet oppgir en bestemt dato, ellers null","varighet":{"antall":6,"enhet":"dager|uker|måneder"},"fra":"mottak|dokumentdato|annet","hva":"hva som må gjøres, kort og uten å gjenta datoen","regel":"hvordan fristen er oppgitt i dokumentet","dok":"dokument-id","sitat":"ordrett","viktighet":"høy|middels|lav"}],
 "neste_steg": [{"steg":"konkret handling","hvorfor":"kort","innen":"YYYY-MM-DD eller null"}]
}`,
      extra: `Sorter fristene etter dato. Ta bare med frister som faktisk følger av dokumentene.
Regn ALDRI ut datoer selv. Oppgir dokumentet en bestemt dato (for eksempel "innen 30. november 2026"), bruk "dato" og sett "varighet" og "fra" til null. Oppgir det en varighet som løper fra mottak eller fra dokumentets dato (for eksempel "seks uker fra du mottok vedtaket"), bruk "varighet" og "fra", og la "dato" være null. Koden regner ut datoen.`,
    },
    c: {
      schema: `{
 "mangler": [{"hva":"kort navn på dokumentasjonen som mangler eller bør styrkes (maks 8 ord)","hvorfor":"hvorfor den trengs, med henvisning til hva dokumentene sier","hvordan":"hvordan den kan skaffes","dok":"dokument-id","sitat":"ordrett"}],
 "ordliste": [{"begrep":"fagord fra dokumentene","forklaring":"enkel forklaring"}]
}`,
      extra: 'Tenk på hva en saksbehandler, et forsikringsselskap eller en advokat ville ønsket å se for å vurdere saken. Ta bare med dokumentasjon noen kan skaffe. Ikke ta med det brukeren selv kan fortelle appen, for eksempel når et brev ble mottatt.',
    },
  },
  en: {
    a: {
      schema: `{
 "sammendrag": "3-5 sentences: what the case is about and what has happened",
 "status": "1-2 sentences: where the case stands now",
 "tidslinje": [{"dato":"YYYY-MM-DD","tittel":"short","beskrivelse":"1-2 sentences","dok":"document id","sitat":"verbatim"}]
}`,
      extra: 'Sort the timeline chronologically.',
    },
    b: {
      schema: `{
 "frister": [{"dato":"YYYY-MM-DD if the document states a specific date, otherwise null","varighet":{"antall":60,"enhet":"days|weeks|months"},"fra":"mottak|dokumentdato|annet","hva":"what must be done, short and without repeating the date","regel":"how the deadline is stated in the document","dok":"document id","sitat":"verbatim","viktighet":"høy|middels|lav"}],
 "neste_steg": [{"steg":"concrete action","hvorfor":"short","innen":"YYYY-MM-DD or null"}]
}`,
      extra: `Sort the deadlines by date. Include only deadlines that actually follow from the documents.
NEVER calculate dates yourself. If the document states a specific date (for example "by November 30, 2026"), use "dato" and set "varighet" and "fra" to null. If it states a duration that runs from receipt or from the date of the document (for example "60 days from the date you receive this notice"), use "varighet" and "fra", and leave "dato" null. The code calculates the date.
For "fra": "mottak" means from receipt, "dokumentdato" means from the date of the document, "annet" means something else.`,
    },
    c: {
      schema: `{
 "mangler": [{"hva":"short name of the documentation that is missing or should be strengthened (at most 8 words)","hvorfor":"why it is needed, referring to what the documents say","hvordan":"how it can be obtained","dok":"document id","sitat":"verbatim"}],
 "ordliste": [{"begrep":"technical term from the documents","forklaring":"plain explanation"}]
}`,
      extra: 'Think about what a caseworker, an insurer or a lawyer would want to see in order to assess the case. Only list documentation that someone can obtain. Do not list things the user can simply tell the app, such as when a letter was received.',
    },
  },
};

/* ---------- Datoer regnes i kode, ikke av modellen. Gjenkjenner norske og engelske formuleringer. ---------- */
const NUMBER_WORDS = { en: 1, ett: 1, one: 1, to: 2, two: 2, tre: 3, three: 3, fire: 4, four: 4, fem: 5, five: 5, seks: 6, six: 6, syv: 7, sju: 7, seven: 7, åtte: 8, eight: 8, ni: 9, nine: 9, ti: 10, ten: 10, elleve: 11, eleven: 11, tolv: 12, twelve: 12 };
const MONTHS_NB = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALT = [...MONTHS_NB, ...MONTHS_EN, ...MONTHS_EN.map((m) => m.slice(0, 3))].join('|');
const EXPLICIT_DATE = new RegExp(
  `\\d{1,2}\\.\\s*(?:${MONTH_ALT})\\.?\\s*\\d{4}|(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALT})\\.?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.\\d{1,2}\\.\\d{4}|\\d{1,2}/\\d{1,2}/\\d{2,4}`,
  'i',
);
const DURATION = /\b(\d{1,3}|en|ett|one|to|two|tre|three|fire|four|fem|five|seks|six|syv|sju|seven|åtte|eight|ni|nine|ti|ten|elleve|eleven|tolv|twelve)[\s-]*(dager|dag|uker|uke|måneder|måned|days?|weeks?|months?)\b([^.]*)/i;

function dateInText(text, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = text.toLowerCase(), nb = MONTHS_NB[m - 1], en = MONTHS_EN[m - 1], enShort = en.slice(0, 3);
  return [
    iso, `${d}. ${nb} ${y}`, `${d}.${m}.${y}`, `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`,
    `${en} ${d}, ${y}`, `${en} ${d} ${y}`, `${enShort} ${d}, ${y}`, `${enShort}. ${d}, ${y}`, `${d} ${en} ${y}`, `${d} ${enShort} ${y}`,
    `${m}/${d}/${y}`, `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`,
  ].some((f) => t.includes(f));
}

// Finner varigheter som "seks uker fra du mottok vedtaket" eller "60 days from the date you receive this notice".
function findDuration(quote, rule) {
  if (EXPLICIT_DATE.test(quote)) return null;
  const m = DURATION.exec(quote) || DURATION.exec(rule);
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  const rest = m[3].toLowerCase();
  const from = /mottok|mottatt|mottak|fikk|receiv|receipt|\bget\b|\bgot\b|\bgets\b/.test(rest) ? 'mottak' : /dato|datert|date of (this|the)|dated|from the date/.test(rest) ? 'dokumentdato' : null;
  return n && from ? { n, unit: m[2], from } : null;
}

function addDuration(iso, n, unit) {
  const d = new Date(`${iso}T12:00:00Z`), u = String(unit).toLowerCase();
  if (/^(dag|day)/.test(u)) d.setUTCDate(d.getUTCDate() + n);
  else if (/^(uke|week)/.test(u)) d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (/^(m[aå]ned|month)/.test(u)) {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  } else return null;
  return d.toISOString().slice(0, 10);
}

function finish(out, docs) {
  for (const k of ['tidslinje', 'frister', 'mangler']) {
    if (!(k in out)) continue;
    out[k] = Array.isArray(out[k]) ? out[k] : [];
    for (const it of out[k]) it.verifisert = verified(docs, it.dok, it.sitat);
  }
  for (const f of out.frister || []) {
    f.dato = validDate(f.dato);
    // Modellen er upålitelig på dato-aritmetikk. Kode regner ut datoen når fristen løper fra mottak eller dokumentdato.
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

export async function analyzeParts(docs, onPart, lang = 'en') {
  lang = normLang(lang);
  const user = formatDocs(docs, lang);
  const results = await Promise.all(
    Object.entries(PARTS[lang]).map(async ([key, p]) => {
      const system = `${INTRO[lang]}
${RULES[lang]()}
${lang === 'nb' ? 'Svar KUN med gyldig JSON uten forklaring rundt, på dette formatet:' : 'Answer ONLY with valid JSON and no explanation around it, in this format:'}
${p.schema}
${p.extra}`;
      const out = finish(await llm(system, user), docs);
      out._lang = lang;
      await onPart?.(key, out);
      return out;
    }),
  );
  return Object.assign({}, ...results);
}

export async function ask(docs, question, lang = 'en') {
  lang = normLang(lang);
  const system = lang === 'nb'
    ? `Du svarer på spørsmål om en sak, kun ut fra dokumentene i saksmappen.
${RULES.nb()}
Svar KUN med JSON: {"svar":"svaret på enkelt norsk","kilder":[{"dok":"dokument-id","sitat":"ordrett"}]}
Hvis dokumentene ikke gir svar, si det i "svar" og anbefal å spørre saksbehandler eller advokat.`
    : `You answer questions about a case, using only the documents in the case folder.
${RULES.en()}
Answer ONLY with JSON: {"svar":"the answer in plain English","kilder":[{"dok":"document id","sitat":"verbatim"}]}
If the documents do not give an answer, say so in "svar" and recommend asking the caseworker or a lawyer.`;
  const out = await llm(system, `${formatDocs(docs, lang)}\n\n---\n${lang === 'nb' ? 'SPØRSMÅL' : 'QUESTION'}: ${question}`);
  out.kilder = (Array.isArray(out.kilder) ? out.kilder : []).map((k) => ({ ...k, verifisert: verified(docs, k.dok, k.sitat) }));
  return out;
}

export async function draft(docs, kind, docId, lang = 'en') {
  lang = normLang(lang);
  const target = docs.find((d) => d.id === docId);
  const SYS = {
    nb: {
      klage: `Du skriver et utkast til klage på et vedtak, basert på hele saksmappen.
${RULES.nb()}
Skriv selve brevet som ren tekst. Bruk [KLAMMER] der personen må fylle inn noe som ikke står i dokumentene (navn, fødselsnummer, referansenummer). Bygg argumentene på det dokumentene faktisk sier, og nevn hvilket dokument hvert poeng bygger på i parentes. Ikke finn opp lovparagrafer eller rettigheter. Til slutt, legg til en liste "Før du sender" med ting personen bør sjekke eller legge ved.`,
      over: `Du lager en overlevering av saken, slik at en advokat eller en ny hjelper raskt kan sette seg inn i den.
${RULES.nb()}
Skriv som ren tekst med disse overskriftene: Hva saken gjelder, Hendelsesforløp, Hvor saken står nå, Frister, Dokumentasjon vi har, Dokumentasjon som mangler, Det vi trenger hjelp med. Henvis til dokumentene med tittel og dato.`,
    },
    en: {
      klage: `You write a draft appeal letter against a decision, based on the whole case folder.
${RULES.en()}
Write the letter itself as plain text. Use [BRACKETS] where the person must fill in something that is not in the documents (name, ID number, reference number). Base the arguments on what the documents actually say, and name the document each point rests on in parentheses. Do not invent laws or rights. At the end, add a list called "Before you send" with things the person should check or attach.`,
      over: `You write a handover summary of the case, so that a lawyer or a new helper can quickly get up to speed.
${RULES.en()}
Write plain text with these headings: What the case is about, Timeline, Where the case stands, Deadlines, Documents we have, Documents that are missing, What we need help with. Refer to documents by title and date.`,
    },
  }[lang];
  const extra = kind === 'klage' && target ? `\n\n${lang === 'nb' ? 'KLAGEN GJELDER DOKUMENT' : 'THE APPEAL CONCERNS DOCUMENT'} ${target.id} (${target.title}).` : '';
  return llm(kind === 'klage' ? SYS.klage : SYS.over, formatDocs(docs, lang) + extra, { json: false });
}

/* ---------- Dokumentinntak: bilder av brev (eller tekst fra PDF) til tekst og forslag til metadata ---------- */
const imagePart = (img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } });

const OCR_PROMPT = {
  nb: 'Skriv av all tekst i dette dokumentet ordrett, uten å tolke eller forklare. Behold avsnitt og linjeskift. Skriv [uleselig] der teksten ikke kan leses, i stedet for å gjette. Svar bare med teksten.',
  en: 'Transcribe all text in this document word for word, without interpreting or explaining. Keep paragraphs and line breaks. Write [illegible] where text cannot be read, instead of guessing. Answer with the text only.',
};

const META_PROMPT = {
  nb: `Se på dette dokumentet og svar KUN med JSON:
{"type":"${DOC_TYPES.join('|')}","tittel":"kort, beskrivende tittel med avsender, for eksempel 'Vedtak fra NAV: avslag på AAP'","dato":"YYYY-MM-DD, dokumentets egen dato, eller null"}
Ikke gjett. Står ikke datoen i dokumentet, bruk null.`,
  en: `Look at this document and answer ONLY with JSON:
{"type":"${DOC_TYPES.join('|')}","tittel":"short, descriptive title that includes the sender, for example 'Decision from the State Disability Agency: application denied'","dato":"YYYY-MM-DD, the document's own date, or null"}
The "type" values mean: vedtak = a decision letter from an agency, legeerklæring = a medical statement, forsikring = an insurance letter, advokat = a letter from a lawyer, innkalling = an appointment or summons, notat = a personal note, annet = anything else.
Do not guess. If the date is not in the document, use null.`,
};

const DEFAULT_TITLE = { nb: 'Dokument', en: 'Document' };

// Hele PDF-en sendes til modellen som en fil. Brukes når PDF-en ikke har tekstlag (skannet).
async function readPdfPages(part, lang) {
  const marker = lang === 'nb' ? 'Sett linjen ---PAGE BREAK--- på egen linje mellom sidene.' : 'Put the line ---PAGE BREAK--- on its own line between pages.';
  const out = await llm(null, [{ type: 'text', text: `${OCR_PROMPT[lang]} ${marker}` }, part], { json: false, maxTokens: 12000 });
  return [out.replace(/\n*-{3}\s*PAGE BREAK\s*-{3}\n*/gi, '\n\f\n')];
}

export async function readDocument({ images = [], text = '', pdf = null, lang = 'en' }) {
  lang = normLang(lang);
  // PDF med tekstlag leveres som tekst. Da trengs ingen bildelesing.
  const hasText = text.trim().length >= 80;
  const pdfPart = pdf && { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${pdf.b64}` } };
  const readImages = images.length > 0 && !hasText;
  const readPdf = !!pdfPart && !hasText && !readImages;
  const metaInput = readImages
    ? [{ type: 'text', text: META_PROMPT[lang] }, imagePart(images[0])]
    : readPdf ? [{ type: 'text', text: META_PROMPT[lang] }, pdfPart] : `${META_PROMPT[lang]}\n\nDOCUMENT:\n${text.slice(0, 6000)}`;
  const [meta, pages] = await Promise.all([
    llm(null, metaInput, { maxTokens: 4000 }).catch(() => ({})),
    readImages
      ? Promise.all(images.map((img) => llm(null, [{ type: 'text', text: OCR_PROMPT[lang] }, imagePart(img)], { json: false, maxTokens: 8000 })))
      : readPdf ? readPdfPages(pdfPart, lang) : [text],
  ]);
  return {
    // Sideskift merkes med \f, slik at et sitat kan knyttes til riktig side.
    text: pages.join('\n\f\n').trim(),
    forslag: {
      type: DOC_TYPES.includes(meta.type) ? meta.type : 'annet',
      tittel: typeof meta.tittel === 'string' && meta.tittel.trim() ? meta.tittel.trim().slice(0, 120) : DEFAULT_TITLE[lang],
      dato: validDate(meta.dato) || '',
    },
  };
}

/* ---------- Taleopptak: hele opptaket sendes som en WAV-fil (mono, 16-bit, 16 eller 24 kHz) ---------- */
export async function transcribeWav(buf) {
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ mode: 'PUSH_TO_TALK', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' })], { type: 'application/json' }));
  form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'voice-note.wav');
  const r = await fetch(`${BASE()}/asr/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${KEY()}` }, body: form, signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message ? `Transcription failed: ${j.error.message}` : `Transcription failed (${r.status})`);
  // Modellen avslutter ofte med to punktum. Resten av teksten røres ikke, den skal rettes av brukeren.
  const text = String(j.transcript || '').trim().replace(/([.!?])[.,]+$/, '$1');
  return { text, seconds: Math.round((j.audioDurationMs || 0) / 1000) };
}
