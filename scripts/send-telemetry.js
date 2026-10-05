import { readFile } from 'node:fs/promises';
import { signBody } from '../src/signature.js';

// Usage: TELEMETRY_KEY_ID=... TELEMETRY_SECRET_BASE64=... node scripts/send-telemetry.js payload.json https://api.example.com
const raw = await readFile(process.argv[2]);
const origin = process.argv[3] || 'http://localhost:3000';
const keyId = process.env.TELEMETRY_KEY_ID;
const secret = Buffer.from(process.env.TELEMETRY_SECRET_BASE64 || '', 'base64');
if (!keyId || secret.length < 32) throw new Error('missing_signing_key');
const timestamp = String(Math.floor(Date.now() / 1000));
const response = await fetch(`${origin}/api/v1/telemetry/settle`, {
  method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Telemetry-Key-Id': keyId,
    'X-Telemetry-Timestamp': timestamp,
    'X-Telemetry-Signature': signBody(secret, keyId, timestamp, raw)
  }, body: raw, signal: AbortSignal.timeout(45000)
});
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
