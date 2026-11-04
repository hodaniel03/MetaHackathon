import { getStore } from '@netlify/blobs';
import { createBlobStore } from '../../lib/blobstore.mjs';

// Cases on the public demo are deleted after 14 days.
export default async () => {
  const n = await createBlobStore(getStore({ name: 'caseally', consistency: 'strong' })).purgeOlderThan(14);
  console.log(`Deleted ${n} old cases`);
};

export const config = { schedule: '0 3 * * *' };
