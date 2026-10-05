import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const SIGNING_PATH = '/api/v1/telemetry/settle';
const Key = z.object({
  key_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  tenant_id: z.uuid(), provider_id: z.uuid(),
  secret_base64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)
}).strict();
export function parseKeys(json) {
  const values = z.array(Key).min(1).parse(JSON.parse(json));
  const keys = new Map();
  for (const key of values) {
    const secret = Buffer.from(key.secret_base64, 'base64');
    if (secret.length < 32 || secret.toString('base64') !== key.secret_base64 || keys.has(key.key_id)) {
      throw new Error('invalid_or_duplicate_provider_key');
    }
    keys.set(key.key_id, { tenantId: key.tenant_id, providerId: key.provider_id, secret });
  }
  return keys;
}
export function signBody(secret, keyId, timestamp, rawBody) {
  return createHmac('sha256', secret)
    .update(`POST\n${SIGNING_PATH}\n${keyId}\n${timestamp}\n`)
    .update(rawBody).digest('hex');
}
export function authenticate(req, keys, nowSeconds = Math.floor(Date.now() / 1000)) {
  const keyId = req.get('x-telemetry-key-id');
  const timestamp = req.get('x-telemetry-timestamp');
  const supplied = req.get('x-telemetry-signature');
  const key = keys.get(keyId);
  if (!key || !/^\d{10}$/.test(timestamp ?? '') ||
    Math.abs(nowSeconds - Number(timestamp)) > 300 ||
    !/^[0-9a-f]{64}$/.test(supplied ?? '') || !Buffer.isBuffer(req.body)) return null;
  const expected = Buffer.from(signBody(key.secret, keyId, timestamp, req.body), 'hex');
  return timingSafeEqual(expected, Buffer.from(supplied, 'hex')) ? key : null;
}
