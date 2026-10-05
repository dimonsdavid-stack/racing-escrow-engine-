import { createApp } from './app.js';
import { parseKeys } from './signature.js';
import { createAdminClient } from './settlement.js';

// Vercel can deploy the health surface before server secrets are provisioned.
// Invalid or incomplete configuration disables every settlement request.
export function createRuntimeApp(env = process.env) {
  let client, keys;
  try {
    keys = parseKeys(env.TELEMETRY_KEYS_JSON || '[]');
    client = createAdminClient(env);
  } catch {
    // Configuration validation errors may contain secrets. Never log them.
    client = undefined;
    keys = new Map();
  }
  return createApp({ client, keys });
}
