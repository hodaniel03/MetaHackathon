# CaseFolder (Saksmappen)

**A case folder for the family member who runs a long benefits or insurance case for someone else.**

You add the letters, decisions and medical statements as they arrive, by photo, PDF or pasted text. CaseFolder reads them, builds a timeline, finds the deadlines, lists what is still missing, and drafts an appeal. Every claim it makes comes with a **word-for-word quote from your document, and the server checks that the quote really is there.**

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

**The shipped app uses one Meta model: `muse-spark-1.3`**, through the Meta Model API (`https://api.meta.ai/v1/chat/completions`, OpenAI-compatible). It does every AI task:

| Task | How it uses Muse Spark 1.3 |
|---|---|
| Read a photographed letter | **Vision.** The image goes in as a base64 data URL. Prompt: transcribe word for word, write `[illegible]` instead of guessing. One call per page, in parallel. |
| Suggest title, type and date | One call on the first page image (or on the text, for PDFs with a text layer). Returns JSON. |
| Analyze the case | **Three parallel calls** over all documents: (a) summary, status, timeline; (b) deadlines and next steps; (c) what is missing and a glossary. Each returns JSON with quotes and document ids. |
| Answer a question | One call. Returns an answer plus sources, each checked like any other claim. |
| Draft an appeal or a handover summary | One call each, plain text. |

Settings: `reasoning_effort: low` (about half the latency of the default in our test), up to 12,000 output tokens (8,000 for page reading, 4,000 for metadata), 150 s timeout, and one automatic retry if the reply is empty or is not valid JSON. The model id, base URL and effort can be changed with environment variables (see *Run it*).

### Other Meta models we tried

The API key lists `muse-spark-1.1`, `1.2`, `1.3`, two `-contributor` variants, `muse-voice-transcribe-1.0`, `muse-image-1.0`, `muse-wonder-1.0` and `sam-3.1`.

- **`muse-voice-transcribe-1.0`:** tested over its WebSocket API. It transcribed a Norwegian and an English clip well, although Meta has not validated Norwegian. **Not integrated yet.** The plan is voice notes ("I spoke to the employer today…") that become documents in the case.
- **Muse Spark reading a PDF directly:** works when the PDF is sent as a `file` content part. **Not used yet.** It would replace the browser-side PDF reader and fix scanned PDFs.
- **Muse Spark as a locator for a quote on the image:** the bounding box it returned was on the wrong line. So the quote highlight is shown in the extracted text, not drawn on the photo.
- **`sam-3.1`:** answered through `/responses`, but returned empty output for our text prompts. We found no sensible use for it here.
- **`muse-image-1.0`, `muse-wonder-1.0`:** no fit for this product, or no documentation found.

---

## What you can do in the app

| Screen | What it does |
|---|---|
| **Overview** | At most three cards: next deadline (big date, days left, *Add to calendar*), what is missing (n of m, checklist preview), latest event. Below: "Is everything checked?" with the count of verified claims, and any unverified claim shown in full. |
| **Timeline** | Events in order. Each is a verified-claim card, collapsed by default. |
| **Documents** | Drop zone for photo or PDF, paste text, list with thumbnail and status (*Read* or *Needs review*). Open a document to read it, see the original, edit the text or delete it. |
| **Deadlines** | Sorted by urgency. Shows the calculation. Asks for the received date when a deadline needs it. Downloads a calendar file (`.ics`) with alerts 7 days and 1 day before. |
| **Missing** | A checklist with 24 px checkboxes. Each item says why it is needed and how to get it, with its source quote. Ticks are saved. |
| **Ask & write** | Ask a question about the case. Draft an appeal letter or a plain-text summary. |
| **Simple view** | A toggle in the header. One column, large text, three headings. |
| **Share** | Copy the case link. Open the printable **handover page** for a lawyer. Rename or delete the case. |

### Reading a letter (the intake step)

1. The browser shrinks photos to at most 1800 px and sends JPEG. PDFs are opened in the browser with pdf.js (3.11.174 from cdnjs), up to 6 pages, each rendered at up to 1500 px wide.
2. If the PDF has a text layer (at least 80 characters per page on average), that text is used directly and no image reading is needed. Otherwise the page images go to Muse Spark.
3. **Review step:** the image sits next to the text we read. Dates, amounts and case numbers are listed as buttons that jump to them in the text, because a wrong date gives a wrong deadline. `[illegible]` markers are flagged. You can correct anything before saving.
4. The document is saved with its original images and the overview is updated.

---

## Architecture

```
Browser: one HTML file, vanilla JavaScript, hash routing, no build step
   |  fetch, and NDJSON streaming for the analysis
Node server (server.mjs): built-in modules only, no npm packages
   |-- lib/db.mjs   SQLite through node:sqlite   (data/saksmappen.db)
   |-- lib/ai.mjs   prompts, Meta API calls, quote check, date computation
   |
Meta Model API: muse-spark-1.3
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
- `POST …/read` (images or PDF text to text plus suggestions)
- `POST …/analyze` (streams each of the three parts as it finishes)
- `POST …/ask`, `POST …/draft`
- `PUT …/checks`
- `GET …/files/:id`, `GET …/calendar.ics` (optional `?i=` for one deadline, `?lang=`)

### Limits

120,000 characters of text per case, up to 6 images per document (each at most 6 MB), 2 MB for normal requests and 25 MB for reading. The analysis takes about 14 to 18 seconds. The first part appears after about 12 seconds.

### Languages

English is the default. Norwegian is selected with the button in the header, `?lang=nb`, or is remembered from earlier. Prompts, page reading, date phrases, dates, plurals and the calendar file all follow the language. The internal JSON keys and document types stay Norwegian in both, so there is nothing to migrate.

---

## Privacy and security

- Text and images you add are **stored on the server** (SQLite in `data/`, ignored by git) and **sent to Meta's model** when read, analyzed or asked about. Use fictional or anonymized documents until you are sure you want to share real ones.
- The API key stays on the server (`.env`, ignored by git) and is never sent to the browser.
- **There is no sign-in.** Anyone who has the case link can see and change the case, including the images. The interface says so. Real accounts are the first thing a real product would need.
- Deleting a case removes all its documents, images, ticks and analysis.
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

**Tested in a browser:** every screen on desktop and mobile width, both languages, the sample cases, photo intake (English and Norwegian), PDF with a text layer, the received-date flow, calendar file structure, checklist saving, keyboard focus, and the automatic size and naming checks. Reading photographs of letters gave 96 to 100 percent of words correct on synthetic test images, including a skewed, dark, noisy, low-resolution one, where one date was misread. That is why the review step cannot be skipped.

**Not tested or not working:**
- Real phone photos, handwriting, stamps and tables. All test images were synthetic.
- Scanned PDFs: the PDF reader hung on any page with an image in the embedded browser we tested in. There is a 20 second timeout and a message, but we have not confirmed it works in regular Chrome or Safari.
- Screen readers, printing to PDF, real devices, several people editing at once, cases above the size limit.
- Ticks are stored by the wording of the item, so a new analysis that words an item differently loses its tick.
- The same decision in two documents can produce two deadlines that are not merged.
- Norwegian speech recognition is not validated by Meta.
- The app has no legal knowledge on purpose. It only uses what the documents say. A letter that states a deadline in a way our date code does not recognize will show *We need a date* or a model-computed date flagged as unchecked.

## Not built yet

Voice notes, sending PDFs straight to the model, real accounts and sharing roles, reminders by email or text, case templates reviewed by experts, and direct connections to agencies' systems.
