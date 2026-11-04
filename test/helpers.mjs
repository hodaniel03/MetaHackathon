import * as ai from '../lib/ai.mjs';
// Runs the same post-processing every analysis part goes through and returns the facts.
export const finishForTest = (out, docs) => ai.finishForTest(out, docs, 'en').fakta;
