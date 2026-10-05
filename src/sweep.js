import { pathToFileURL } from 'node:url';
import { createAdminClient, callRpc } from './settlement.js';
import { safeLogger } from './logging.js';

// Run once per minute with an external scheduler. Multiple workers are safe:
// each refund serializes on the same challenge lock as telemetry settlement.
export async function sweep(client, { limit = 100, log = console.log } = {}) {
  const writeLog = safeLogger(log);
  const items = await callRpc(client, 'list_expired_challenges', { p_limit: limit });
  let failures = 0;
  for (const item of items) {
    try {
      const result = await callRpc(client, 'refund_expired_challenge', {
        p_tenant_id: item.tenant_id, p_challenge_id: item.challenge_id
      });
      writeLog(JSON.stringify({ event: 'timeout_refund', ...item, duplicate: result.duplicate }));
    } catch (error) {
      failures++;
      writeLog(JSON.stringify({ event: 'timeout_refund_failed', ...item, code: error.code || 'NETWORK' }));
    }
  }
  return { processed: items.length, failures };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await sweep(createAdminClient());
    if (result.failures) process.exitCode = 1;
  } catch { console.error('sweep_failed_check_configuration_and_database'); process.exitCode = 1; }
}
