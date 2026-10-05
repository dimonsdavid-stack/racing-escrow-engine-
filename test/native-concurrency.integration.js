// Native PostgreSQL, independent connections. NEVER point this at production.
// Run against a new disposable database with RACING_ALLOW_TEST_DATABASE=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { seed,create,settle,settlementArgs,challenge,T,A,B } from './fixtures.js';

async function waitForBackend(admin,pid,expected,timeoutMs=2000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const {rows}=await admin.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',[pid]);
    if(rows[0] && expected(rows[0])) return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('database_backend_did_not_reach_expected_wait_state');
}

test('native PostgreSQL concurrent escrow mutations', async t => {
  if (!process.env.DATABASE_URL || process.env.RACING_ALLOW_TEST_DATABASE !== '1') {
    throw new Error('requires_DATABASE_URL_and_RACING_ALLOW_TEST_DATABASE_1_for_a_new_disposable_database');
  }
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:12,connectionTimeoutMillis:5000});
  let admin;
  try {
    admin=await pool.connect();
    const existing=await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='race_private'");
    assert.equal(existing.rowCount,0,'fresh disposable database required; refusing to modify an existing installation');
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;`);
    await admin.query(await readFile(new URL('../sql/001_engine.sql',import.meta.url),'utf8'));
    async function reset() {
      await admin.query(`TRUNCATE race_private.telemetry_events,race_private.journal_lines,
        race_private.journal_transactions,race_private.challenges,race_private.treasury,
        race_private.users,race_private.providers,race_private.tenants RESTART IDENTITY`);
      await seed(admin);
    }
    async function concurrent(tasks) {
      const acquired=await Promise.allSettled(tasks.map(()=>pool.connect()));
      const clients=acquired.filter(r=>r.status==='fulfilled').map(r=>r.value);
      const failed=acquired.find(r=>r.status==='rejected');
      if(failed) {clients.forEach(c=>c.release());throw failed.reason;}
      try {
        await Promise.all(clients.map(c=>c.query('SET ROLE service_role')));
        return await Promise.allSettled(tasks.map((fn,i)=>fn(clients[i])));
      } finally {
        const reset=await Promise.allSettled(clients.map(c=>c.query('RESET ROLE')));
        clients.forEach((c,i)=>c.release(reset[i].status==='rejected'?reset[i].reason:undefined));
        const failedReset=reset.find(r=>r.status==='rejected');
        if(failedReset)throw failedReset.reason;
      }
    }
    async function assertConservation() {
      const {rows}=await admin.query(`SELECT
        (SELECT sum(gc_balance) FROM race_private.users WHERE tenant_id=$1)
        +coalesce((SELECT sum(remaining_escrow) FROM race_private.challenges WHERE tenant_id=$1 AND token_type='GC'),0)
        +coalesce((SELECT sum(balance) FROM race_private.treasury WHERE tenant_id=$1 AND token_type='GC'),0) AS total`,[T]);
      assert.equal(rows[0].total,'200.000000');
      assert.equal((await admin.query('SELECT sum(delta)::text AS total FROM race_private.journal_lines')).rows[0].total,'0.000000');
    }
    await t.test('same funding request on eight connections debits once',async()=>{
      await reset();const c=challenge();
      const results=await concurrent(Array.from({length:8},()=>db=>create(db,c)));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,8);
      assert.equal(results.filter(r=>r.value?.duplicate===false).length,1);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM race_private.challenges')).rows[0].n,1);
      await assertConservation();
    });
    await t.test('distinct simultaneous challenges cannot overspend a shared wallet',async()=>{
      await reset();const c1=challenge({p_entry_fee:'80'}),c2=challenge({p_entry_fee:'80'});
      const results=await concurrent([db=>create(db,c1),db=>create(db,c2)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='PT409').length,1);
      assert.equal((await admin.query('SELECT min(gc_balance)::text AS b FROM race_private.users WHERE tenant_id=$1',[T])).rows[0].b,'20.000000');
      await assertConservation();
    });
    await t.test('opposite participant order acquires canonical wallet locks without deadlock',async()=>{
      await reset();const c1=challenge({p_entry_fee:'40'}),c2=challenge({p_entry_fee:'50',p_challenger_id:B,p_opponent_id:A});
      const results=await concurrent([db=>create(db,c1),db=>create(db,c2)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
      await assertConservation();
    });
    await t.test('eight identical final events credit winner and treasury exactly once',async()=>{
      await reset();const c=challenge();await create(admin,c);const args=settlementArgs(c);
      const results=await concurrent(Array.from({length:8},()=>db=>settle(db,args)));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,8);
      assert.equal(results.filter(r=>r.value?.duplicate===false).length,1);
      assert.equal((await admin.query('SELECT gc_balance::text AS b FROM race_private.users WHERE tenant_id=$1 AND id=$2',[T,A])).rows[0].b,'108.000000');
      await assertConservation();
    });
    await t.test('contradictory final events serialize; only one terminal posting is permitted',async()=>{
      await reset();const c=challenge();await create(admin,c);
      const x=settlementArgs(c),y=settlementArgs(c,{p_payload_sha256:'b'.repeat(64),p_winner_id:B,p_challenger_best:'70',p_opponent_best:'60'});
      const results=await concurrent([db=>settle(db,x),db=>settle(db,y)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='PT409').length,1);
      await assertConservation();
    });
    await t.test('late telemetry versus timeout workers gives only a complete, fee-free refund',async()=>{
      await reset();const c=challenge();await create(admin,c);
      await admin.query("UPDATE race_private.challenges SET telemetry_deadline=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[T,c.p_request_id]);
      const args=settlementArgs(c);
      const results=await concurrent([
        db=>settle(db,args),
        db=>db.query('SELECT public.refund_expired_challenge($1,$2)',[T,c.p_request_id]),
        db=>db.query('SELECT public.refund_expired_challenge($1,$2)',[T,c.p_request_id])
      ]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
      assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='PT409').length,1);
      assert.equal((await admin.query('SELECT min(gc_balance)::text AS b FROM race_private.users WHERE tenant_id=$1',[T])).rows[0].b,'100.000000');
      await assertConservation();
    });
    for(const end of ['COMMIT','ROLLBACK']) {
      await t.test(`uncommitted settlement blocks its retry; ${end.toLowerCase()} chooses replay or fresh payout`,async()=>{
        await reset();const c=challenge();await create(admin,c);const args=settlementArgs(c);
        const holder=await pool.connect(),waiter=await pool.connect();
        let pending;
        try {
          await holder.query('BEGIN');await holder.query('SET LOCAL ROLE service_role');
          await waiter.query('SET ROLE service_role');
          await settle(holder,args); // Returns while its surrounding transaction remains open.
          pending=settle(waiter,args).then(result=>({result}),error=>({error}));
          await waitForBackend(admin,waiter.processID,row=>row.wait_event_type==='Lock');
          // A different connection cannot observe a credit/event before commit.
          assert.equal((await admin.query('SELECT gc_balance::text AS b FROM race_private.users WHERE tenant_id=$1 AND id=$2',[T,A])).rows[0].b,'90.000000');
          assert.equal((await admin.query('SELECT count(*)::int AS n FROM race_private.telemetry_events')).rows[0].n,0);
          await holder.query(end);
          const finished=await pending;
          if(finished.error)throw finished.error;
          assert.equal(finished.result.duplicate,end==='COMMIT');
          assert.equal((await admin.query("SELECT count(*)::int AS n FROM race_private.journal_transactions WHERE kind='settle'")).rows[0].n,1);
          await assertConservation();
        }finally {
          await holder.query('ROLLBACK').catch(()=>{});
          if(pending)await pending;
          await waiter.query('RESET ROLE').catch(()=>{});
          holder.release();waiter.release();
        }
      });
    }
    await t.test('cancelling a backend during final-event persistence rolls back every credit and preserves escrow',async()=>{
      await reset();const c=challenge();await create(admin,c);const args=settlementArgs(c);
      await admin.query(`CREATE FUNCTION race_private.pause_event_posting() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(10); RETURN NEW; END; $$;
        CREATE TRIGGER pause_event BEFORE INSERT ON race_private.telemetry_events
        FOR EACH ROW EXECUTE FUNCTION race_private.pause_event_posting();`);
      const writer=await pool.connect();let pending;
      try {
        await writer.query('SET ROLE service_role');
        pending=settle(writer,args).then(result=>({result}),error=>({error}));
        await waitForBackend(admin,writer.processID,row=>row.wait_event==='PgSleep');
        assert.equal((await admin.query('SELECT pg_cancel_backend($1) AS cancelled',[writer.processID])).rows[0].cancelled,true);
        const cancelled=await pending;assert.equal(cancelled.error?.code,'57014');
        assert.equal((await admin.query('SELECT gc_balance::text AS b FROM race_private.users WHERE tenant_id=$1 AND id=$2',[T,A])).rows[0].b,'90.000000');
        assert.equal((await admin.query('SELECT remaining_escrow::text AS e FROM race_private.challenges')).rows[0].e,'20.000000');
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM race_private.treasury')).rows[0].n,0);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM race_private.telemetry_events')).rows[0].n,0);
        await admin.query('DROP TRIGGER pause_event ON race_private.telemetry_events');
        assert.equal((await settle(writer,args)).duplicate,false);
        await assertConservation();
      }finally {
        if(pending) {await admin.query('SELECT pg_cancel_backend($1)',[writer.processID]).catch(()=>{});await pending;}
        await writer.query('RESET ROLE').catch(()=>{});writer.release();
        await admin.query('DROP TRIGGER IF EXISTS pause_event ON race_private.telemetry_events');
        await admin.query('DROP FUNCTION race_private.pause_event_posting()');
      }
    });
    await t.test('SERIALIZABLE funding conflict rolls back the whole losing transaction',async()=>{
      await reset();const c1=challenge({p_entry_fee:'80'}),c2=challenge({p_entry_fee:'80'});
      async function serializable(db,c) {
        await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        try {const result=await create(db,c);await db.query('COMMIT');return result;}
        catch(error) {await db.query('ROLLBACK');throw error;}
      }
      const results=await concurrent([db=>serializable(db,c1),db=>serializable(db,c2)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.filter(r=>r.status==='rejected'&&['40001','PT409'].includes(r.reason.code)).length,1);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM race_private.challenges')).rows[0].n,1);
      await assertConservation();
    });
    await t.test('simultaneous GC and SC funding preserves two isolated currency balances',async()=>{
      await reset();const gc=challenge({p_entry_fee:'70'}),sc=challenge({p_entry_fee:'70',p_token_type:'SC'});
      const results=await concurrent([db=>create(db,gc),db=>create(db,sc)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
      const {rows}=await admin.query('SELECT gc_balance::text AS gc,sc_balance::text AS sc FROM race_private.users WHERE tenant_id=$1 ORDER BY id',[T]);
      assert.deepEqual(rows,[{gc:'30.000000',sc:'30.000000'},{gc:'30.000000',sc:'30.000000'}]);
      const scTotal=await admin.query(`SELECT
        (SELECT sum(sc_balance) FROM race_private.users WHERE tenant_id=$1)
        +(SELECT sum(remaining_escrow) FROM race_private.challenges WHERE tenant_id=$1 AND token_type='SC') AS total`,[T]);
      assert.equal(scTotal.rows[0].total,'200.000000');
      await assertConservation();
    });
  }finally {admin?.release();await pool.end();}
});
