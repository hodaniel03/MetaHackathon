# CaseFolder (Saksmappen)

**A case folder for the family member who runs a long benefits or insurance case for someone else.**

You add the letters, decisions and medical statements as they arrive, by photo, PDF, pasted text or a voice note. CaseFolder reads them, builds a timeline, finds the deadlines, lists what is still missing, and drafts an appeal. Every claim it makes comes with a **word-for-word quote from your document, and the server checks that the quote really is there.**

The app is in English by default and also works in Norwegian (called *Saksmappen*). It was built for the Meta Global AI Developer Hackathon, theme **Build for Your World**, from the author's own experience of helping family through disability benefits, insurance claims and a lawyer.

> CaseFolder organizes and explains. It does not give legal advice. All sample documents are fictional.

---

## The problem

Long cases with an agency, an insurer and a lawyer are hard in the same ways:

- The documents are scattered across inboxes and paper.
- Nobody remembers what happened when, and why.
- Many deadlines run from the day you *received* a letter, and are easy to lose track of.
- A denial says something is missing, but not in a form you can act on.
- You tell the same story again and again, and pay a lawyer to read the file first.
- Doing it for someone else adds the fear of making a mistake.

## Who it is for

- **The Helper (primary):** an adult, often a son, daughter, sibling or partner, running the case for a relative. No legal background, tired, afraid to miss something.
- **The person the case is about (secondary):** gets a *Simple view* with large text, no jargon and three headings only: what happened, what happens now, what you need to do.
- **A lawyer or support service (tertiary):** gets a printable handover page.

---

## The one principle: verifiable trust

An AI that just *says* things does not help someone who is afraid of being wrong. So every claim is shown as **Claim, then Quote, then Source document and page.**

- The model must give a quote copied word for word from the document.
- The server then checks that the quote is in the document text (case, quote marks and whitespace are ignored). The result is shown as **Checked against the document** or **Could not be checked. Check yourself.**
- **Dates are calculated by code, not by the model.** Early testing showed the model getting date arithmetic wrong (six weeks from October 16 came back as November 28; it is November 27). Now the model only reports the *duration* ("6 weeks", "60 days") and what it runs from (receipt or the letter's date). The code adds it to the date you enter. The deadline screen shows the sum: *You received the letter Oct 16 + 60 days = Dec 15*.
- A date the model gives that appears **neither in the document nor was computed by code** is marked *The date is not in the document* in an amber box.
- If a deadline depends on when you received the letter and you have not entered that, the app asks you instead of guessing.

What the check does **not** do: it confirms the quote is in the text we read. It does not confirm that the text was read correctly from a photo (the review step exists for that), and it does not confirm that the model's *interpretation* of the quote is right. Drafts (appeal letter, summary) are not verified quote by quote.

---

## Meta models

**The shipped app uses two Meta models**, both through the Meta Model API (`https://api.meta.ai/v1`):

- **`muse-spark-1.3`** reads, understands and writes. It does every text and vision task.
- **`muse-voice-transcribe-1.0`** turns a recorded voice note into text.

| Task | Model and how |
|---|---|
| Read a photographed letter | Muse Spark 1.3, **vision**. The image goes in as a base64 data URL. Prompt: transcribe word for word, write `[illegible]` instead of guessing. One call per page, in parallel. |
| Read a scanned PDF | Muse Spark 1.3, with the **whole PDF sent as a file part**. Pages are separated by a marker line. No page rendering in the browser. |
| Suggest title, type and date | Muse Spark 1.3. One call on the first page image, the PDF, or the text. Returns JSON. |
| Analyze the case | Muse Spark 1.3, **three parallel calls** over all documents: (a) summary, status, timeline; (b) deadlines and next steps; (c) what is missing and a glossary. Each returns JSON with quotes and document ids. |
| Answer a question | Muse Spark 1.3. One call. Returns an answer plus sources, each checked like any other claim. |
| Draft an appeal or a handover summary | Muse Spark 1.3. One call each, plain text. |
| Turn a voice note into text | **Muse Voice Transcribe**, through its file API (`POST /v1/asr/transcribe`, multipart, WAV). A 15 second note took about 7 seconds. |

Muse Spark settings: `reasoning_effort: low` (about half the latency of the default in our test), up to 12,000 output tokens (8,000 for page reading, 4,000 for metadata), 150 s timeout, and one automatic retry if the reply is empty or is not valid JSON. The model id, base URL and effort can be changed with environment variables (see *Run it*).

### Other Meta models we tried

The API key lists `muse-spark-1.1`, `1.2`, `1.3`, two `-contributor` variants, `muse-voice-transcribe-1.0`, `muse-image-1.0`, `muse-wonder-1.0` and `sam-3.1`.

- **`sam-3.1` (tested properly, not used).** It takes a noun phrase and an image through `/v1/responses` and returns a box and a mask per match as special-token text. It found the sheet of paper in a phone photo exactly, but cropping to it did not improve reading (98%, 98%, 97% of words, with and without the crop, three runs each). It found "ink scribble" on a drawn signature but not "signature" or "handwriting". A segmenter finds objects, not the *content* of text, so it cannot find a national ID number. A "redacted copy" built on it would hide signatures and leave the numbers readable, and that gives false comfort. So the redaction we ship is pattern-based and says what it can miss (see *Privacy and security*).
- **Muse Spark as a locator for a quote on the image:** the bounding box it returned was on the wrong line. So the quote highlight is shown in the extracted text, not drawn on the photo.
- **`muse-image-1.0`, `muse-wonder-1.0`:** no fit for this product, or no documentation found. We did not force them in.

---

## What you can do in the app

| Screen | What it does |
|---|---|
| **Overview** | First, **"Is everything checked?"** as three big numbers: claims, checked against the document, could not be checked. Any claim we could not check is shown in full right below. Then at most three cards: next deadline (big date, days left, *Add to calendar*), what is missing (n of m), latest event. |
| **Timeline** | Events in order. Each is a verified-claim card, collapsed by default. |
| **Documents** | Drop zone for photo or PDF, **Record a voice note**, paste text. A list with thumbnail and status (*Read* or *Needs review*). Open a document to read it, see the original, edit the text or delete it. |
| **Deadlines** | Sorted by urgency. Shows the calculation. Asks for the received date when a deadline needs it. Downloads a calendar file (`.ics`) with alerts 7 days and 1 day before. |
| **Missing** | A checklist with 24 px checkboxes. Each item says why it is needed and how to get it, with its source quote. Ticks are saved. |
| **Ask & write** | Ask a question about the case. Draft an appeal letter or a plain-text summary. |
| **Simple view** | A toggle in the header. One column, large text, three headings. |
| **Share** | Copy the case link. Open the printable **handover page** for a lawyer, with a **Hide ID numbers** switch. Rename or delete the case. |

### Voice notes

Most of what happens in a long case happens on the phone. Tap **Record a voice note**, say what was said, and stop. The recording is turned into text by Muse Voice Transcribe, and you check and correct the text before it is saved as a document of the kind *Voice note*.

- The audio is recorded in the browser, converted to a 24 kHz mono WAV file, and sent once. **The audio is not stored**, only the text you choose to save.
- A voice note is labeled as such everywhere. A quote from it says **"From your voice note, not an official document"**, and the badge says *Checked against your voice note*. The analysis is told to treat it as what *you* say, never as a decision or a statement from an agency, and to say that a deadline from a call should be confirmed in writing.
- The review step flags dates, amounts and case numbers, and words that appear twice in a row. The speech model sometimes repeats a word ("work work"), and we do not silently change what it returned.
- Recording needs a secure page (`localhost` or HTTPS), and the browser asks for microphone permission.

### Reading a letter (the intake step)

1. **Photos:** the browser shrinks them to at most 1800 px and sends JPEG. Several photos become pages of one document.
2. **PDFs:** the browser reads only the **text layer** with pdf.js (3.11.174 from cdnjs), up to 6 pages. Pages are *not* drawn, because drawing a page that contains an image hung pdf.js in the browser we tested in. If the PDF has a text layer (at least 80 characters per page on average), that text is used and only the title, type and date need the model. If it has none, which is the case for a scan, **the whole PDF goes to Muse Spark as a file**. If pdf.js cannot load at all, the same fallback is used. The original PDF is stored and opens in a new tab.
3. **Review step:** for a photo, the image sits next to the text we read. Dates, amounts and case numbers are listed as buttons that jump to them in the text, because a wrong date gives a wrong deadline. `[illegible]` markers are flagged. You can correct anything before saving.
4. The document is saved with its original and the overview is updated.

---

## Architecture

```
Browser: one HTML file, vanilla JavaScript, hash routing, no build step
   |  fetch, and NDJSON streaming for the analysis
Node server (server.mjs): built-in modules only, no npm packages
   |-- lib/db.mjs   SQLite through node:sqlite   (data/saksmappen.db)
   |-- lib/ai.mjs   prompts, Meta API calls, quote check, date computation
   |
Meta Model API: muse-spark-1.3 (text, vision, PDF), muse-voice-transcribe-1.0 (speech)
```

### Files

- `server.mjs`: routes, limits, static file, calendar file.
- `lib/ai.mjs`: all prompts in English and Norwegian, `analyzeParts`, `ask`, `draft`, `readDocument`, the quote check and the date code.
- `lib/db.mjs`: schema and queries.
- `public/index.html`: the whole interface (styles, texts for both languages, screens).
- `samples/`: a fictional case in each language, each with a precomputed analysis so the demo starts instantly.

### Data

Five tables: `cases`, `documents`, `files` (original images, as blobs), `checks` (ticked items) and `analysis` (one row per analysis part, with a hash of the documents it was made from). If the documents change, the stored analysis is marked stale and the app offers to update it. Unattached uploaded images are deleted after an hour.

A case is identified by a long random token, and the link containing it is the only access control.

### API

All routes are under `/api/cases`.

- `POST /api/cases`, `POST /api/cases/sample`
- `GET`, `PUT`, `DELETE /api/cases/:token`
- `POST /api/cases/:token/documents`, `PUT` and `DELETE …/documents/:id`
- `POST …/read` (images, a PDF, or PDF text, to text plus suggestions)
- `POST …/voice` (a WAV recording to text; the audio is not stored)
- `POST …/analyze` (streams each of the three parts as it finishes)
- `POST …/ask`, `POST …/draft`
- `PUT …/checks`
- `GET …/files/:id`, `GET …/calendar.ics` (optional `?i=` for one deadline, `?lang=`)

### Limits

120,000 characters of text per case, up to 6 images per document (each at most 6 MB), a PDF of at most 14 MB, a voice note of at most 5 minutes, 2 MB for normal requests and 25 to 30 MB for reading and voice. The analysis takes about 14 to 18 seconds. The first part appears after about 12 seconds.

### Languages

English is the default. Norwegian is selected with the button in the header, `?lang=nb`, or is remembered from earlier. Prompts, page reading, date phrases, dates, plurals and the calendar file all follow the language. The internal JSON keys and document types stay Norwegian in both, so there is nothing to migrate.

---

## Privacy and security

- Voice notes are recorded in the browser and sent for transcription. **The audio is not stored**, only the text you save.
- Text and images you add are **stored on the server** (SQLite in `data/`, ignored by git) and **sent to Meta's model** when read, analyzed or asked about. Use fictional or anonymized documents until you are sure you want to share real ones.
- The API key stays on the server (`.env`, ignored by git) and is never sent to the browser.
- **There is no sign-in.** Anyone who has the case link can see and change the case, including the images. The interface says so. Real accounts are the first thing a real product would need.
- Deleting a case removes all its documents, images, ticks and analysis.
- The handover page can **hide personal ID numbers** it recognizes. This is pattern matching, not a guarantee, and it says so on the page.
- We have not reviewed Meta's data terms for API input, or what EEA storage rules would require. Do not use real sensitive data until that is done.

## Accessibility and design

Calm, light-only design with a warm off-white background and navy ink. Status is never shown by color alone (always an icon and text). No text under 14 px, 44 px touch targets, visible focus rings, a skip link, one `h1` per screen, mobile first. Amber text uses `#7A5500` on the amber tint, because `#9A6B00` there is 4.28:1 and fails WCAG AA. Text size, touch-target size, accessible names and the single `h1` were checked automatically on all 18 screen and language combinations (8 screens in each language, plus the simple view in each) with no deviations. Screen readers were **not** tested.

---

## Run it

Requires **Node 22 or newer** (for `node:sqlite`). Tested on Node 22.23.

Create a `.env` file in the project folder:

```
META_API_KEY=your-key
```

Optional variables: `META_BASE_URL` (default `https://api.meta.ai/v1`), `META_MODEL` (default `muse-spark-1.3`), `META_EFFORT` (default `low`), `PORT` (default `3000`), `DB_FILE`.

```
node --no-warnings server.mjs
```

Open `http://localhost:3000` and choose **See a fictional sample case**. Restart the server after changing server code. The page itself reloads normally.

Fonts come from Google Fonts and the PDF reader from cdnjs, so you need internet for those. Without it, photos and pasted text still work.

---

## What has been tested, and what has not

**Tested in a browser:** every screen on desktop and mobile width, both languages, the sample cases, photo intake in English and Norwegian, a PDF with a text layer, a **scanned PDF (read in about 7 seconds, in the same browser where the old approach hung)**, the received-date flow, calendar file structure, checklist saving, keyboard focus, the voice-note dialog in all its states, a WAV file built by the page's own code (accepted by the API), saving a voice note and seeing it labeled and analyzed, and the ID-number hiding. Text size, touch-target size, accessible names and the single `h1` were checked automatically on all 18 screen and language combinations, and on the voice dialog in every phase and language, with no deviations. Reading photographs of letters gave 96 to 100 percent of words correct on synthetic test images, including a skewed, dark, noisy, low-resolution one, where one date was misread. That is why the review step cannot be skipped.

**Not tested or not working:**
- **The microphone itself.** It is blocked in the browser pane we developed in. The error message for a blocked microphone was tested, and so was everything after the recording (WAV building, upload, transcription, review, saving), but not the recording step, nor real speech from a person. The speech tests used a synthetic voice.
- Speech transcripts contain repeated words now and then, and Norwegian is not validated by Meta.
- Real phone photos, handwriting, stamps and tables. All image tests were synthetic.
- A scanned PDF with many pages (the model reads the whole file, we have only tried one page).
- Screen readers, printing to PDF, real devices, several people editing at once, cases above the size limit.
- The ID-number hiding is pattern-based (Norwegian national ID, US Social Security number, Norwegian bank account number). It misses other formats, names and addresses. It is not a guarantee.
- Ticks are stored by the wording of the item, so a new analysis that words an item differently loses its tick.
- The same decision in two documents can produce two deadlines that are not merged.
- The app has no legal knowledge on purpose. It only uses what the documents say. A letter that states a deadline in a way our date code does not recognize will show *We need a date* or a model-computed date flagged as unchecked.

## Not built yet

Real accounts and sharing roles, reminders by email or text, more languages (the prompts and texts are separated per language, so another one is a dictionary and a set of prompts, but it needs a native speaker to check), case templates reviewed by experts, and direct connections to agencies' systems.
