import { createClient } from '@supabase/supabase-js';

export class RpcError extends Error {
  constructor(code = 'NETWORK', status = 0) {
    super('rpc_failed'); this.code = code; this.status = status;
  }
}
export function createAdminClient(env = process.env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('missing_supabase_configuration');
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('supabase_requires_https');
  }
  return createClient(url.href, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'public' }
  });
}
const transient = new Set(['NETWORK', '40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03', '08000', '08003', '08006']);
export function retryable(error) {
  // Business/constraint failures remain terminal even if a transport wrapper
  // omitted the HTTP status. A caller must not retry a conflicting event.
  if ((/^PT4\d\d$/.test(error.code) && !['PT408','PT429'].includes(error.code)) || /^(22|23)/.test(error.code)) return false;
  return transient.has(error.code) || error.status === 0 || error.status === 429 || error.status >= 500;
}
// Each RPC attempt is a single transaction. Never chain .update() calls.
// A timeout means UNKNOWN COMMIT STATUS, not proof of rollback. Same parameters
// and same event ID make retries safe even if the first attempt committed.
export async function callRpc(client, name, args, {
  attempts = 3, timeoutMs = 12000,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || typeof wait !== 'function') {
    throw new TypeError('invalid_rpc_retry_configuration');
  }
  // Snapshot before the first await: the originating application may mutate its
  // request object while a response/retry is pending. Every attempt must use the
  // same request ID, terms and normalized decision as the initial attempt.
  const rpcArgs = Object.freeze(structuredClone(args));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { data, error, status } = await client.rpc(name, rpcArgs).abortSignal(AbortSignal.timeout(timeoutMs));
      if (error) throw new RpcError(error.code || 'NETWORK', status);
      if (data === null || data === undefined) throw new RpcError('EMPTY_RESULT', 502);
      return data;
    } catch (cause) {
      const error = cause instanceof RpcError ? cause : new RpcError('NETWORK');
      if (!retryable(error) || attempt === attempts - 1) throw error;
      await wait(100 * (2 ** attempt) + Math.floor(Math.random() * 100));
    }
  }
}
export function settleCalculatedWinner(client, identity, payload, decision, payloadSha256, options) {
  // Identity comes exclusively from the server's signature-key mapping.
  return callRpc(client, 'settle_challenge', {
    p_tenant_id: identity.tenantId, p_provider_id: identity.providerId,
    p_challenge_id: payload.challenge_id, p_session_id: payload.session_id,
    p_event_id: payload.event_id, p_payload_sha256: payloadSha256,
    p_challenger_id: payload.challenger_id, p_opponent_id: payload.opponent_id,
    p_resolution: decision.resolution, p_winner_id: decision.winnerId,
    p_challenger_best: decision.challengerBest, p_opponent_best: decision.opponentBest
  }, options);
}
export function createAndLockChallenge(client, args, options) {
  // Call only after the application has verified BOTH participants' acceptance
  // of these exact terms. This is a trusted backend primitive, never a browser RPC.
  if (typeof args.p_entry_fee !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(args.p_entry_fee)) {
    throw new Error('entry_fee_must_be_decimal_string');
  }
  return callRpc(client, 'create_and_lock_challenge', args, options);
}
