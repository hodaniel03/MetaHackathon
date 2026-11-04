import { getStore } from '@netlify/blobs';
import { createHandler } from '../../lib/app.mjs';
import { createBlobStore } from '../../lib/blobstore.mjs';

const handle = createHandler(createBlobStore(getStore({ name: 'caseally', consistency: 'strong' })), { hosted: true, env: process.env });

export default async (req, context) => handle(req, { ip: context.ip });

export const config = { path: '/api/*' };
