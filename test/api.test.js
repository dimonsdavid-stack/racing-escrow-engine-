import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { signBody, parseKeys } from '../src/signature.js';
import { callRpc, RpcError, retryable } from '../src/settlement.js';
import { sweep } from '../src/sweep.js';
import { challenge, telemetry, T, P, A } from './fixtures.js';

const secret=randomBytes(32), keyId='test-key';
const keys=new Map([[keyId,{tenantId:T,providerId:P,secret}]]);
function stub(handler) {
  return {rpc(name,args){return {abortSignal(){return Promise.resolve().then(()=>handler(name,args));}};}};
}
async function withServer(client,fn) {
  const server=createApp({client,keys,log:()=>{},rpcOptions:{attempts:1}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {await fn(`http://127.0.0.1:${server.address().port}`);} finally {await new Promise(resolve=>server.close(resolve));}
}
function headers(raw,offset=0) {
  const ts=String(Math.floor(Date.now()/1000)+offset);
  return {'Content-Type':'application/json','X-Telemetry-Key-Id':keyId,
    'X-Telemetry-Timestamp':ts,'X-Telemetry-Signature':signBody(secret,keyId,ts,raw)};
}
test('signed endpoint derives tenant from key and makes one transactional settlement RPC',async()=>{
  let calls=0;
  await withServer(stub((name,args)=>{
    calls++;assert.equal(name,'settle_challenge');assert.equal(args.p_tenant_id,T);
    assert.equal(args.p_provider_id,P);assert.equal(args.p_winner_id,A);
    assert.equal(args.p_challenger_best,'60.000001');assert.match(args.p_payload_sha256,/^[0-9a-f]{64}$/);
    return {data:{status:'Settled',resolution:'winner',duplicate:false},error:null,status:200};
  }),async origin=>{
    const raw=JSON.stringify(telemetry(challenge()));
    const response=await fetch(`${origin}/api/v1/telemetry/settle`,{method:'POST',headers:headers(raw),body:raw});
    assert.equal(response.status,200);assert.equal((await response.json()).status,'Settled');
  });
  assert.equal(calls,1);
});
test('tampered signatures, stale timestamps, malformed JSON and duplicate drivers do not reach DB',async()=>{
  let calls=0;
  await withServer(stub(()=>{calls++;throw new Error('must_not_call');}),async origin=>{
    const post=(raw,h)=>fetch(`${origin}/api/v1/telemetry/settle`,{method:'POST',headers:h,body:raw});
    const raw=JSON.stringify(telemetry(challenge()));
    assert.equal((await post(`${raw} `,headers(raw))).status,401);
    assert.equal((await post(raw,headers(raw,-301))).status,401);
    assert.equal((await post('{',headers('{'))).status,400);
    const packet=telemetry(challenge());packet.drivers[1].user_id=A;
    const invalid=JSON.stringify(packet);
    assert.equal((await post(invalid,headers(invalid))).status,422);
    assert.equal((await post(raw,{'Content-Type':'text/plain'})).status,415);
  });
  assert.equal(calls,0);
});
test('RPC outage responds 503 and never initiates a compensating refund',async()=>{
  const calls=[];
  await withServer(stub(name=>{calls.push(name);return {error:{code:'08006'},status:503};}),async origin=>{
    const raw=JSON.stringify(telemetry(challenge()));
    const response=await fetch(`${origin}/api/v1/telemetry/settle`,{method:'POST',headers:headers(raw),body:raw});
    assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'2');
  });
  assert.deepEqual(calls,['settle_challenge']);
});
test('serialization and unknown commit retries preserve exact request identity',async()=>{
  let calls=0;const args={p_event_id:'stable'};
  const result=await callRpc(stub((name,sent)=>{
    calls++;assert.deepEqual(sent,args);assert.equal(name,'settle_challenge');
    if(calls===1)throw new Error('lost_response_after_commit');
    return {data:{duplicate:true},error:null,status:200};
  }),'settle_challenge',args,{wait:async()=>{}});
  assert.equal(result.duplicate,true);assert.equal(calls,2);
  calls=0;
  await assert.rejects(callRpc(stub(()=>{calls++;return {error:{code:'PT409'},status:409};}),'x',{},
    {wait:async()=>{}}),RpcError);
  assert.equal(calls,1);
});
test('retry argument snapshot survives caller mutation while response is pending',async()=>{
  let calls=0;
  const args={p_event_id:'original',p_payload:{value:'original'}};
  const result=await callRpc(stub((_name,sent)=>{
    calls++;assert.equal(sent.p_event_id,'original');assert.equal(sent.p_payload.value,'original');
    if(calls===1)throw new Error('unknown_commit_status');
    return {data:{duplicate:true},error:null,status:200};
  }),'settle_challenge',args,{wait:async()=>{
    args.p_event_id='mutated';args.p_payload.value='mutated';
  }});
  assert.equal(result.duplicate,true);assert.equal(calls,2);
});
test('invalid retry options fail before any RPC; missing status cannot make a conflict retryable',async()=>{
  let calls=0;const client=stub(()=>{calls++;});
  for(const attempts of [0,-1,6,1.5]) {
    await assert.rejects(callRpc(client,'settle_challenge',{}, {attempts}),TypeError);
  }
  assert.equal(calls,0);
  assert.equal(retryable(new RpcError('PT409')),false);
  assert.equal(retryable(new RpcError('23514',500)),false);
  assert.equal(retryable(new RpcError('40001',500)),true);
  assert.equal(retryable(new RpcError('PT429',429)),true);
});
test('a failed logging sink cannot turn a committed settlement into an HTTP error',async()=>{
  const client=stub(()=>({data:{status:'Settled',resolution:'winner',duplicate:false},error:null,status:200}));
  const server=createApp({client,keys,log:()=>{throw new Error('sink_unavailable');}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
    const raw=JSON.stringify(telemetry(challenge()));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/telemetry/settle`,{
      method:'POST',headers:headers(raw),body:raw});
    assert.equal(response.status,200);assert.equal((await response.json()).status,'Settled');
  }finally {await new Promise(resolve=>server.close(resolve));}
});
test('timeout sweep processes refunds successfully when its logging sink is unavailable',async()=>{
  const calls=[];
  const client=stub((name,args)=>{
    calls.push({name,args});
    return {data:name==='list_expired_challenges'?[{tenant_id:T,challenge_id:'expired'}]:{duplicate:false},error:null,status:200};
  });
  assert.deepEqual(await sweep(client,{log:()=>{throw new Error('sink_unavailable');}}),{processed:1,failures:0});
  assert.deepEqual(calls.map(c=>c.name),['list_expired_challenges','refund_expired_challenge']);
});
test('key parser requires long secrets and rejects duplicate key IDs',()=>{
  const key={key_id:keyId,tenant_id:T,provider_id:P,secret_base64:secret.toString('base64')};
  assert.equal(parseKeys(JSON.stringify([key])).size,1);
  assert.throws(()=>parseKeys(JSON.stringify([key,key])));
  assert.throws(()=>parseKeys(JSON.stringify([{...key,secret_base64:'YQ=='}])));
});
