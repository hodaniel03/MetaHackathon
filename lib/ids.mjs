import crypto from 'node:crypto';

export const newToken = () => crypto.randomBytes(16).toString('base64url');
export const newId = (prefix) => prefix + crypto.randomBytes(5).toString('hex');
