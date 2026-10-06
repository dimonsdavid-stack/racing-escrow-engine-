import { createApp } from "./app.js";
import { parseKeys } from "./signature.js";
import { createAdminClient } from "./settlement.js";

// Vercel can deploy the health surface before server secrets are provisioned.
// Invalid or incomplete configuration disables every settlement request.
export function createRuntimeApp(env = process.env) {
  let client, keys;
  try {
    client = createAdminClient(env);
  } catch {
    // Configuration validation errors may contain secrets. Never log them.
    client = undefined;
  }
  try {
    keys = parseKeys(env.TELEMETRY_KEYS_JSON || "[]");
  } catch {
    keys = new Map();
  }
  let brokerKeys;
  try {
    brokerKeys = parseKeys(env.DISCORD_BROKER_KEYS_JSON || "[]");
  } catch {
    brokerKeys = new Map();
  }
  let complianceKeys, operatorKeys;
  try {
    complianceKeys = parseKeys(env.COMPLIANCE_KEYS_JSON || "[]");
  } catch {
    complianceKeys = new Map();
  }
  try {
    operatorKeys = parseKeys(env.OPERATOR_KEYS_JSON || "[]");
  } catch {
    operatorKeys = new Map();
  }
  // Roles cannot share a signing secret, even when key identifiers differ.
  const rings = [keys, brokerKeys, complianceKeys, operatorKeys],
    seen = new Set();
  let collision = false;
  for (const ring of rings)
    for (const key of ring.values()) {
      const value = key.secret.toString("base64");
      if (seen.has(value)) collision = true;
      seen.add(value);
    }
  if (collision) for (const ring of rings) ring.clear();
  return createApp({
    env,
    brokerKeys,
    client,
    keys,
    complianceKeys,
    operatorKeys,
    customerOptions: { env },
    cronSecret: env.CRON_SECRET,
  });
}
