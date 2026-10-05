-- Example only: bind values with your SQL client's parameters. PostgREST supplies
-- this transaction automatically when using supabase.rpc(). The ledger's ordered
-- row locks are sufficient for balance safety at READ COMMITTED; SERIALIZABLE
-- additionally rejects serialization anomalies and requires whole-call retries.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
SELECT public.create_and_lock_challenge(
  p_tenant_id := '11111111-1111-4111-8111-111111111111',
  p_request_id := '44444444-4444-4444-8444-444444444444',
  p_challenger_id := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  p_opponent_id := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  p_token_type := 'GC',
  p_entry_fee := 10.00,
  p_provider_id := '22222222-2222-4222-8222-222222222222',
  p_session_id := '33333333-3333-4333-8333-333333333333',
  p_telemetry_deadline := now() + interval '2 hours'
);
COMMIT;
