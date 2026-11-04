// 18 synthetic, fictional cases with ground truth. All names, agencies, numbers and dates are made up.
// The expected dates are computed here with plain Date arithmetic, separately from the app's own date code.
const plus = (iso, n, unit) => {
  const d = new Date(`${iso}T12:00:00Z`);
  if (unit === 'days') d.setUTCDate(d.getUTCDate() + n);
  else if (unit === 'weeks') d.setUTCDate(d.getUTCDate() + 7 * n);
  else { const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); }
  return d.toISOString().slice(0, 10);
};
const doc = (id, title, type, date, text, o = {}) => ({ id, title, type, date, received: o.received || '', source: o.source || 'tekst', text });

export const CASES = [
  { id: 'en-01-appeal-60d-received', lang: 'en', tags: ['duration', 'receipt'],
    docs: [doc('d1', 'Decision from the State Disability Agency', 'vedtak', '2026-10-14', 'State Disability Agency\nDECISION\nDate: October 14, 2026\n\nYour application for disability benefits is denied. The agency finds that the impairment is not documented by a specialist.\nYou have 60 days from the date you receive this notice to file an appeal.\nTo strengthen an appeal, submit a statement from a medical specialist.', { received: '2026-10-16' })],
    expect: { deadlines: [plus('2026-10-16', 60, 'days')], missing: [['specialist']] } },
  { id: 'en-02-appeal-30d-docdate', lang: 'en', tags: ['duration', 'document-date'],
    docs: [doc('d1', 'Housing board decision', 'vedtak', '2026-09-10', 'Fictional Housing Board\nDecision dated September 10, 2026\n\nYour housing support application is denied because your income is above the limit.\nYou may appeal within 30 days of the date of this letter.')],
    expect: { deadlines: [plus('2026-09-10', 30, 'days')], missing: [] } },
  { id: 'en-03-explicit-date', lang: 'en', tags: ['explicit'],
    docs: [doc('d1', 'Letter from Example Insurance Co.', 'forsikring', '2026-10-20', 'Example Insurance Co.\nOctober 20, 2026\n\nWe have received your claim. To continue we need copies of all receipts for treatment costs.\nPlease submit the receipts by November 30, 2026, or the claim will be closed.')],
    expect: { deadlines: ['2026-11-30'], missing: [['receipt']] } },
  { id: 'en-04-two-deadlines', lang: 'en', tags: ['duration', 'receipt', 'multiple'],
    docs: [doc('d1', 'Pension office decision', 'vedtak', '2026-07-30', 'Fictional Pension Office\nDecision, July 30, 2026\n\nYour request is partly approved.\nYou can appeal within 45 days from the day you receive this decision.\nIf you accept the decision you must return the enclosed form within 14 days from the day you receive it.', { received: '2026-08-03' })],
    expect: { deadlines: [plus('2026-08-03', 45, 'days'), plus('2026-08-03', 14, 'days')], missing: [] } },
  { id: 'en-05-no-deadline', lang: 'en', tags: ['no-deadline'],
    docs: [doc('d1', 'Status letter', 'forsikring', '2026-10-01', 'Example Insurance Co.\nOctober 1, 2026\n\nThis is to confirm that we have received your documents. Your claim is being processed. No action is needed from you at this time.')],
    expect: { deadlines: [], missing: [] } },
  { id: 'en-06-appointment-distractor', lang: 'en', tags: ['distractor'],
    docs: [doc('d1', 'Appointment notice', 'innkalling', '2026-11-05', 'Fictional Orthopedic Clinic\nYou are scheduled for an appointment on December 2, 2026 at 09:00.\nIf you cannot attend, please cancel at least 48 hours before the appointment. Bring your MRI images.')],
    expect: { deadlines: ['2026-12-02'], missing: [] } },
  { id: 'en-07-weeks-no-received', lang: 'en', tags: ['duration', 'needs-received'],
    docs: [doc('d1', 'Agency decision', 'vedtak', '2026-10-22', 'Fictional Welfare Agency\nDecision dated October 22, 2026\n\nYour application is denied. You have six weeks from receipt to appeal.')],
    expect: { deadlines: [], needsReceived: true, missing: [] } },
  { id: 'en-08-voice-note', lang: 'en', tags: ['voice', 'explicit'],
    docs: [doc('d1', 'Voice note: call with the lawyer', 'notat', '2026-10-27', 'The lawyer said that we need to send the medical report to the court by November 20, 2026. She also said we should get a statement from the employer about the work tasks.', { source: 'tale' })],
    expect: { deadlines: ['2026-11-20'], missing: [['employer']] } },
  { id: 'en-09-multi-docs', lang: 'en', tags: ['duration', 'receipt', 'multi-doc'],
    docs: [
      doc('d1', 'Employer letter', 'notat', '2026-08-15', 'Example Employer Ltd\nAugust 15, 2026\nJordan has been on sick leave since August 1, 2026. The employer cannot adjust the work duties.'),
      doc('d2', 'Medical statement', 'legeerklæring', '2026-09-05', 'Dr. Sam Fictional\nSeptember 5, 2026\nDiagnosis: lower back injury. The patient cannot lift more than 5 kg. An MRI has been ordered but the report is not available yet.'),
      doc('d3', 'Insurance decision', 'forsikring', '2026-09-28', 'Example Insurance Co.\nSeptember 28, 2026\nYour claim for lost income is denied for now. You may file a complaint within 28 days from the day you receive this letter. A specialist statement and the MRI report would help.', { received: '2026-10-01' })],
    expect: { deadlines: [plus('2026-10-01', 28, 'days')], missing: [['mri'], ['specialist']] } },
  { id: 'en-10-illegible-date', lang: 'en', tags: ['illegible'],
    docs: [doc('d1', 'Scanned decision', 'vedtak', '2026-10-09', 'Fictional Welfare Agency\nDecision dated October 9, 2026\n\nYour application is denied. Appeals must be filed by [illegible] [illegible] 2026.')],
    expect: { deadlines: [], missing: [], forbidDatedDeadline: true } },

  { id: 'nb-11-klage-6uker-mottatt', lang: 'nb', tags: ['duration', 'receipt'],
    docs: [doc('d1', 'Vedtak fra Fiktiv Velferdsetat', 'vedtak', '2026-09-22', 'Fiktiv Velferdsetat\nVEDTAK\nDato: 22. september 2026\n\nVi avslår søknaden din om stønad.\nDu kan klage innen seks uker fra du mottok vedtaket.', { received: '2026-09-25' })],
    expect: { deadlines: [plus('2026-09-25', 6, 'weeks')], missing: [] } },
  { id: 'nb-12-klage-3uker-dokdato', lang: 'nb', tags: ['duration', 'document-date'],
    docs: [doc('d1', 'Vedtak fra Fiktiv Boligetat', 'vedtak', '2026-10-05', 'Fiktiv Boligetat\nVedtak datert 5. oktober 2026\n\nSøknaden om boligstøtte er avslått. Klagefristen er tre uker fra datoen på dette brevet.')],
    expect: { deadlines: [plus('2026-10-05', 3, 'weeks')], missing: [] } },
  { id: 'nb-13-eksplisitt-dato', lang: 'nb', tags: ['explicit'],
    docs: [doc('d1', 'Brev fra Fiktiv Velferdsetat', 'vedtak', '2026-11-02', 'Fiktiv Velferdsetat\n2. november 2026\n\nFor å behandle saken din trenger vi en legeerklæring som beskriver funksjonsnedsettelsen. Dokumentasjonen må sendes innen 15. desember 2026.')],
    expect: { deadlines: ['2026-12-15'], missing: [['legeerklæring']] } },
  { id: 'nb-14-to-frister', lang: 'nb', tags: ['duration', 'receipt', 'multiple'],
    docs: [doc('d1', 'Vedtak og innkalling', 'vedtak', '2026-10-08', 'Fiktiv Velferdsetat\nVedtak, 8. oktober 2026\n\nSøknaden din er delvis innvilget. Du kan klage innen fire uker fra du mottok vedtaket. Du må svare på innkallingen til samtale innen ti dager fra du mottok brevet.', { received: '2026-10-12' })],
    expect: { deadlines: [plus('2026-10-12', 4, 'weeks'), plus('2026-10-12', 10, 'days')], missing: [] } },
  { id: 'nb-15-ingen-frist', lang: 'nb', tags: ['no-deadline'],
    docs: [doc('d1', 'Bekreftelse', 'forsikring', '2026-10-03', 'Fiktiv Forsikring AS\n3. oktober 2026\n\nVi bekrefter at vi har mottatt dokumentene dine. Saken er under behandling. Du trenger ikke gjøre noe nå.')],
    expect: { deadlines: [], missing: [] } },
  { id: 'nb-16-maaneder-slutt', lang: 'nb', tags: ['duration', 'document-date', 'month-end'],
    docs: [doc('d1', 'Vedtak om midlertidig stønad', 'vedtak', '2026-08-31', 'Fiktiv Velferdsetat\nVedtak datert 31. august 2026\n\nStønaden er midlertidig. Du må levere ny søknad innen 3 måneder fra datoen på dette brevet.')],
    expect: { deadlines: [plus('2026-08-31', 3, 'months')], missing: [] } },
  { id: 'nb-17-talenotat', lang: 'nb', tags: ['voice', 'explicit'],
    docs: [doc('d1', 'Talenotat: samtale med saksbehandler', 'notat', '2026-11-03', 'Saksbehandleren sa at vi må sende inn skjemaet innen 1. desember 2026. Hun sa også at vi må skaffe en uttalelse fra fastlegen.', { source: 'tale' })],
    expect: { deadlines: ['2026-12-01'], missing: [['fastlegen', 'uttalelse']] } },
  { id: 'nb-18-mangler-liste', lang: 'nb', tags: ['explicit', 'missing'],
    docs: [doc('d1', 'Brev om manglende dokumenter', 'vedtak', '2026-10-27', 'Fiktiv Boligetat\n27. oktober 2026\n\nSøknaden din mangler opplysninger. Vi mangler arbeidsgiverattest og kopi av leiekontrakt. Dokumentene må være hos oss innen 3. november 2026.')],
    expect: { deadlines: ['2026-11-03'], missing: [['arbeidsgiverattest'], ['leiekontrakt']] } },

  // Harder on purpose: the app's date code knows days, weeks and months, not working days or "end of next month".
  { id: 'en-19-working-days', lang: 'en', tags: ['duration', 'receipt', 'hard', 'working-days'],
    docs: [doc('d1', 'Agency request', 'vedtak', '2026-10-14', 'Fictional Welfare Agency\nOctober 14, 2026\n\nWe need more information about your income. You must respond within 5 working days of receipt of this letter.', { received: '2026-10-16' })],
    expect: { deadlines: ['2026-10-23'], missing: [] } },
  { id: 'nb-20-slutten-av-maaneden', lang: 'nb', tags: ['hard', 'end-of-month'],
    docs: [doc('d1', 'Brev fra Fiktiv Velferdsetat', 'vedtak', '2026-09-14', 'Fiktiv Velferdsetat\n14. september 2026\n\nDu må sende oss lønnsslipper. Fristen er utgangen av måneden etter datoen på dette brevet.')],
    expect: { deadlines: ['2026-10-31'], missing: [['lønnsslipp']] } },
];
