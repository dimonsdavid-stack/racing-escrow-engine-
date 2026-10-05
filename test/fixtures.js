import { randomUUID } from 'node:crypto';

export const T = '11111111-1111-4111-8111-111111111111';
export const T2 = '99999999-9999-4999-8999-999999999999';
export const P = '22222222-2222-4222-8222-222222222222';
export const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export function challenge(overrides = {}) {
  return {
    p_tenant_id: T, p_request_id: randomUUID(), p_challenger_id: A,
    p_opponent_id: B, p_token_type: 'GC', p_entry_fee: '10.00',
    p_provider_id: P, p_session_id: randomUUID(),
    p_telemetry_deadline: new Date(Date.now() + 3600000).toISOString(), ...overrides
  };
}
export function telemetry(c, overrides = {}) {
  return {
    event_id: randomUUID(), challenge_id: c.p_request_id,
    session_id: c.p_session_id, challenger_id: c.p_challenger_id,
    opponent_id: c.p_opponent_id, final: true, race_status: 'completed',
    drivers: [
      { user_id: c.p_challenger_id, laps: [{ is_clean: true, lap_time_seconds: '60.000001' }] },
      { user_id: c.p_opponent_id, laps: [{ is_clean: true, lap_time_seconds: '62.000001' }] }
    ], ...overrides
  };
}
export async function seed(db) {
  await db.query(`INSERT INTO race_private.tenants(id,name,sc_enabled) VALUES($1,'Test tenant',true),($2,'Other tenant',true)`, [T,T2]);
  await db.query(`INSERT INTO race_private.providers(tenant_id,id) VALUES($1,$2),($3,$2)`,[T,P,T2]);
  for (const tenant of [T,T2]) {
    for (const user of [A,B]) {
      await db.query(`INSERT INTO race_private.users(tenant_id,id,auth_user_id) VALUES($1,$2,$2)`,[tenant,user]);
      for (const token of ['GC','SC']) {
        await db.query(`SELECT public.credit_wallet($1,$2,$3,$4,$5)`, [tenant,user,token,'100',`${user}:${token}`]);
      }
    }
  }
}
export async function create(db,c) {
  const {rows} = await db.query(`SELECT public.create_and_lock_challenge($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result`,Object.values(c));
  return rows[0].result;
}
export function settlementArgs(c, extra = {}) {
  return {
    p_tenant_id: c.p_tenant_id, p_provider_id: c.p_provider_id,
    p_challenge_id: c.p_request_id,p_session_id:c.p_session_id,
    p_event_id:randomUUID(),p_payload_sha256:'a'.repeat(64),
    p_challenger_id:c.p_challenger_id,p_opponent_id:c.p_opponent_id,
    p_resolution:'winner',p_winner_id:c.p_challenger_id,
    p_challenger_best:'60.000001',p_opponent_best:'62.000001',...extra
  };
}
export async function settle(db,args) {
  const {rows} = await db.query(`SELECT public.settle_challenge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS result`,Object.values(args));
  return rows[0].result;
}
