import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { seed, create, settle, settlementArgs, challenge, T, T2, P, A, B } from './fixtures.js';

async function database(beforeSchema) {
  const db=new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  if(beforeSchema) await beforeSchema(db);
  await db.exec(await readFile(new URL('../sql/001_engine.sql',import.meta.url),'utf8'));
  await seed(db);
  return db;
}
async function balances(db,tenant=T) {
  return (await db.query('SELECT id,gc_balance::text AS gc,sc_balance::text AS sc FROM race_private.users WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
}
test('schema applies; funding locks exactly two wallets; settlement pays 90% and preserves SC',async()=>{
  const db=await database();
  try {
    const c=challenge();
    await db.exec('SET ROLE service_role');
    const funded=await create(db,c);
    assert.equal(funded.pool,'20.000000');assert.equal(funded.rake,'2.000000');
    const result=await settle(db,settlementArgs(c));assert.equal(result.winner_payout,'18.000000');
    await db.exec('RESET ROLE');
    assert.deepEqual(await balances(db),[{id:A,gc:'108.000000',sc:'100.000000'},{id:B,gc:'90.000000',sc:'100.000000'}]);
    assert.equal((await db.query('SELECT balance::text AS b FROM race_private.treasury')).rows[0].b,'2.000000');
    assert.equal((await db.query('SELECT sum(delta)::text AS total FROM race_private.journal_lines')).rows[0].total,'0.000000');
  } finally {await db.close();}
});
test('installation leaves unrelated overloaded public functions and their grants intact',async()=>{
  const db=await database(db=>db.exec(`CREATE FUNCTION public.credit_wallet(text)
    RETURNS text LANGUAGE sql AS $$ SELECT 'unrelated-overload'::text; $$;`));
  try {
    await db.exec('SET ROLE anon');
    assert.equal((await db.query("SELECT public.credit_wallet('probe') AS value")).rows[0].value,'unrelated-overload');
    await db.exec('RESET ROLE');
  }finally {await db.close();}
});
test('insufficient funds and invalid decimals leave both balances and escrow unchanged',async()=>{
  const db=await database();
  try {
    const before=await balances(db);
    for(const fee of ['101','0','-1','1.001','NaN','Infinity']) {
      await assert.rejects(create(db,challenge({p_entry_fee:fee})));
    }
    assert.deepEqual(await balances(db),before);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM race_private.challenges')).rows[0].n,0);
  }finally {await db.close();}
});
test('funding and settlement are idempotent; changed request or event body conflicts',async()=>{
  const db=await database();
  try {
    const c=challenge();await create(db,c);
    assert.equal((await create(db,c)).duplicate,true);
    await assert.rejects(create(db,{...c,p_entry_fee:'11'}),{code:'PT409'});
    const args=settlementArgs(c);await settle(db,args);
    const before=await balances(db);assert.equal((await settle(db,args)).duplicate,true);
    assert.deepEqual(await balances(db),before);
    await assert.rejects(settle(db,{...args,p_payload_sha256:'b'.repeat(64)}),{code:'PT409'});
    await assert.rejects(settle(db,{...args,p_event_id:randomUUID()}),{code:'PT409'});
    assert.equal((await db.query("SELECT count(*)::int AS n FROM race_private.journal_transactions WHERE kind='settle'")).rows[0].n,1);
  }finally {await db.close();}
});
test('no laps, network drop and tie each refund the complete pool without charging rake',async()=>{
  const db=await database();
  try {
    for(const reason of ['no_clean_laps','network_drop','tie']) {
      const c=challenge({p_token_type:'SC',p_entry_fee:'10.01'});await create(db,c);
      const args=settlementArgs(c,{p_resolution:reason,p_winner_id:null,
        p_challenger_best:reason==='tie'?'60':null,p_opponent_best:reason==='tie'?'60':null});
      const result=await settle(db,args);assert.equal(result.rake_charged,'0');assert.equal(result.refund_per_user,'10.010000');
      assert.deepEqual(await balances(db),[{id:A,gc:'100.000000',sc:'100.000000'},{id:B,gc:'100.000000',sc:'100.000000'}]);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM race_private.treasury')).rows[0].n,0);
  }finally {await db.close();}
});
test('tenant, session, provider, participants and outcome are revalidated inside the DB',async()=>{
  const db=await database();
  try {
    const c=challenge();await create(db,c);const base=settlementArgs(c);
    for(const change of [{p_tenant_id:T2},{p_provider_id:randomUUID()},
      {p_session_id:randomUUID()},{p_challenger_id:B},{p_winner_id:randomUUID()},
      {p_winner_id:B},{p_challenger_best:'0'},{p_opponent_best:'NaN'}]) {
      await assert.rejects(settle(db,{...base,...change}));
    }
    assert.equal((await db.query('SELECT remaining_escrow::text AS pool FROM race_private.challenges')).rows[0].pool,'20.000000');
    assert.deepEqual(await balances(db,T2),[{id:A,gc:'100.000000',sc:'100.000000'},{id:B,gc:'100.000000',sc:'100.000000'}]);
    await assert.rejects(create(db,challenge({p_opponent_id:randomUUID()})),{code:'PT404'});
    await db.query('UPDATE race_private.tenants SET sc_enabled=false WHERE id=$1',[T]);
    await assert.rejects(create(db,challenge({p_token_type:'SC'})),{code:'PT403'});
  }finally {await db.close();}
});
test('injected posting failure rolls back wallet credits, treasury, event and terminal state',async()=>{
  const db=await database();
  try {
    const c=challenge();await create(db,c);const before=await balances(db);
    await db.exec(`CREATE FUNCTION race_private.inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected_failure'; END; $$;
      CREATE TRIGGER failure BEFORE INSERT ON race_private.telemetry_events FOR EACH ROW EXECUTE FUNCTION race_private.inject_failure();`);
    const args=settlementArgs(c);await assert.rejects(settle(db,args));
    assert.deepEqual(await balances(db),before);
    assert.equal((await db.query('SELECT status,remaining_escrow::text AS pool FROM race_private.challenges')).rows[0].status,'Active');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM race_private.treasury')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM race_private.telemetry_events')).rows[0].n,0);
    await db.exec('DROP TRIGGER failure ON race_private.telemetry_events');
    assert.equal((await settle(db,args)).status,'Settled');
  }finally {await db.close();}
});
test('expired sessions refund once; early timeout and late telemetry cannot settle',async()=>{
  const db=await database();
  try {
    const c=challenge();await create(db,c);
    await assert.rejects(db.query('SELECT public.refund_expired_challenge($1,$2)',[T,c.p_request_id]),{code:'PT409'});
    await db.query("UPDATE race_private.challenges SET telemetry_deadline=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[T,c.p_request_id]);
    await assert.rejects(settle(db,settlementArgs(c)),{code:'PT409'});
    const due=(await db.query('SELECT public.list_expired_challenges(100) AS result')).rows[0].result;
    assert.equal(due.length,1);
    const refund=()=>db.query('SELECT public.refund_expired_challenge($1,$2) AS result',[T,c.p_request_id]);
    assert.equal((await refund()).rows[0].result.resolution,'timeout');
    assert.equal((await refund()).rows[0].result.duplicate,true);
    assert.deepEqual(await balances(db),[{id:A,gc:'100.000000',sc:'100.000000'},{id:B,gc:'100.000000',sc:'100.000000'}]);
  }finally {await db.close();}
});
test('API roles cannot mutate tables, users cannot execute finance RPCs, journal is append-only',async()=>{
  const db=await database();
  try {
    for(const role of ['anon','authenticated','service_role']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.query('UPDATE race_private.users SET gc_balance=1000'));
      if(role!=='service_role') await assert.rejects(create(db,challenge()));
      await db.exec('RESET ROLE');
    }
    await assert.rejects(db.query('UPDATE race_private.journal_lines SET delta=1'),{code:'PT409'});
    await assert.rejects(db.query('DELETE FROM race_private.journal_transactions'),{code:'PT409'});
    await db.exec('SET ROLE service_role');
    await assert.rejects(db.query(`SELECT race_private.finish_challenge($1,$2,$3,'bad',$4,'winner',$5,1,2,false)`,
      [T,randomUUID(),P,'a'.repeat(64),A]));
    await db.exec('RESET ROLE');
  }finally {await db.close();}
});
test('deferred balance constraint rejects unbalanced journal transactions at commit',async()=>{
  const db=await database();
  try {
    await db.exec('BEGIN');
    const tx=randomUUID();
    await db.query(`INSERT INTO race_private.journal_transactions(tenant_id,id,token_type,kind,external_ref)
      VALUES($1,$2,'GC','grant','bad-grant')`,[T,tx]);
    await db.query(`INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta)
      VALUES($1,$2,'User',$3,10),($1,$2,'Issuance',NULL,-9)`,[T,tx,A]);
    await assert.rejects(db.exec('COMMIT'),{code:'23514'});
    await db.exec('ROLLBACK');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM race_private.journal_transactions WHERE external_ref='bad-grant'")).rows[0].n,0);
  }finally {await db.close();}
});
test('grants retry once; reconciliation detects any projection drift',async()=>{
  const db=await database();
  try {
    const grant=[T,A,'GC','0.123456','promo:stable'];
    const rpc=()=>db.query('SELECT public.credit_wallet($1,$2,$3,$4,$5) AS result',grant);
    assert.equal((await rpc()).rows[0].result.duplicate,false);
    assert.equal((await rpc()).rows[0].result.duplicate,true);
    await assert.rejects(db.query('SELECT public.credit_wallet($1,$2,$3,$4,$5)',[T,B,'GC','0.123456','promo:stable']),{code:'PT409'});
    const c=challenge({p_entry_fee:'0.01'});await create(db,c);
    const result=await settle(db,settlementArgs(c));
    assert.equal(result.rake_charged,'0.002000');
    const audit=await readFile(new URL('../sql/003_reconcile.sql',import.meta.url),'utf8');
    assert.equal((await db.query(audit)).rows.length,0);
    await db.query('UPDATE race_private.users SET gc_balance=gc_balance+1 WHERE tenant_id=$1 AND id=$2',[T,A]);
    const drift=(await db.query(audit)).rows;
    assert.equal(drift.length,1);assert.equal(drift[0].drift,'1.000000');
  }finally {await db.close();}
});
test('interrupted refund retains original escrow and debited balances until a successful retry',async()=>{
  const db=await database();
  try {
    const c=challenge();await create(db,c);const before=await balances(db);
    await db.exec(`CREATE FUNCTION race_private.inject_refund_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refund_failure'; END; $$;
      CREATE TRIGGER failure BEFORE INSERT ON race_private.telemetry_events FOR EACH ROW EXECUTE FUNCTION race_private.inject_refund_failure();`);
    const args=settlementArgs(c,{p_resolution:'network_drop',p_winner_id:null});
    await assert.rejects(settle(db,args));assert.deepEqual(await balances(db),before);
    assert.equal((await db.query('SELECT remaining_escrow::text AS pool FROM race_private.challenges')).rows[0].pool,'20.000000');
    await db.exec('DROP TRIGGER failure ON race_private.telemetry_events');
    assert.equal((await settle(db,args)).refund_per_user,'10.000000');
    assert.equal((await db.query(await readFile(new URL('../sql/003_reconcile.sql',import.meta.url),'utf8'))).rows.length,0);
  }finally {await db.close();}
});
