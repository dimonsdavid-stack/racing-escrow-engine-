import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { signBody } from '../src/signature.js';
import { seed,create,settle,challenge,telemetry,T,P,A,B } from './fixtures.js';

test('signed HTTP request flows through validation into PostgreSQL and durable replay',async()=>{
  const db=new PGlite();
  let server;
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    await db.exec(await readFile(new URL('../sql/001_engine.sql',import.meta.url),'utf8'));
    await seed(db);const c=challenge();await create(db,c);
    const secret=randomBytes(32),keyId='e2e';
    // This adapter replaces the HTTP transport only; it executes the same SQL RPC.
    // It deliberately does not emulate multiple concurrent database sessions.
    const client={rpc(name,args){assert.equal(name,'settle_challenge');return {async abortSignal(){
      try {await db.exec('SET ROLE service_role');return {data:await settle(db,args),error:null,status:200};}
      catch(error){return {data:null,error:{code:error.code},status:Number(error.code?.slice(2))||500};}
      finally {await db.exec('RESET ROLE');}
    }};}};
    server=createApp({client,keys:new Map([[keyId,{tenantId:T,providerId:P,secret}]]),log:()=>{}}).listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const raw=JSON.stringify(telemetry(c));
    async function post(bytes=raw) {
      const timestamp=String(Math.floor(Date.now()/1000));
      return fetch(`http://127.0.0.1:${server.address().port}/api/v1/telemetry/settle`,{
        method:'POST',headers:{'Content-Type':'application/json','X-Telemetry-Key-Id':keyId,
          'X-Telemetry-Timestamp':timestamp,'X-Telemetry-Signature':signBody(secret,keyId,timestamp,bytes)},body:bytes});
    }
    const first=await post();assert.equal(first.status,200);assert.equal((await first.json()).duplicate,false);
    const retry=await post();assert.equal(retry.status,200);assert.equal((await retry.json()).duplicate,true);
    // Same semantic JSON but different bytes is a different signed commitment.
    assert.equal((await post(`${raw} `)).status,409);
    const {rows}=await db.query('SELECT id,gc_balance::text AS b FROM race_private.users WHERE tenant_id=$1 ORDER BY id',[T]);
    assert.deepEqual(rows,[{id:A,b:'108.000000'},{id:B,b:'90.000000'}]);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    await db.close();
  }
});
