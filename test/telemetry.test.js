import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry, decide, bestCleanLap, secondsToMicros } from '../src/telemetry.js';
import { challenge, telemetry, A, B } from './fixtures.js';

test('dirty, negative, and zero laps are ignored; minimum clean positive time wins', () => {
  assert.equal(bestCleanLap([
    {is_clean:false,lap_time_seconds:1}, {is_clean:true,lap_time_seconds:0},
    {is_clean:true,lap_time_seconds:-1}, {is_clean:true,lap_time_seconds:'80.000001'},
    {is_clean:true,lap_time_seconds:'60.123456'}
  ]),60123456n);
  const result=decide(Telemetry.parse(telemetry(challenge())));
  assert.equal(result.winnerId,A);
  assert.equal(result.challengerBest,'60.000001');
});
test('empty laps refund; one clean driver wins; identical microseconds refund a tie', () => {
  const payload=telemetry(challenge());
  payload.drivers[0].laps=[];payload.drivers[1].laps=[];
  assert.equal(decide(payload).resolution,'no_clean_laps');
  payload.drivers[1].laps=[{is_clean:true,lap_time_seconds:10}];
  assert.equal(decide(payload).winnerId,B);
  payload.drivers[0].laps=[{is_clean:true,lap_time_seconds:'10.000000'}];
  assert.equal(decide(payload).resolution,'tie');
});
test('signed network drop takes precedence over logged laps', () => {
  const payload=telemetry(challenge(),{race_status:'network_drop'});
  assert.equal(decide(payload).winnerId,null);
  assert.equal(decide(payload).resolution,'network_drop');
});
test('malformed values, duplicate/foreign drivers, nonfinal packets, tenant injection are rejected', () => {
  for(const value of [NaN,Infinity,'NaN','1e3','0.0000001',true,null,'86401']) {
    const payload=telemetry(challenge());payload.drivers[0].laps[0].lap_time_seconds=value;
    assert.equal(Telemetry.safeParse(payload).success,false,String(value));
  }
  const payload=telemetry(challenge());payload.drivers[1].user_id=A;
  assert.equal(Telemetry.safeParse(payload).success,false);
  assert.equal(Telemetry.safeParse(telemetry(challenge(),{final:false})).success,false);
  assert.equal(Telemetry.safeParse(telemetry(challenge(),{tenant_id:'injected'})).success,false);
  assert.equal(secondsToMicros(0.1),100000n);
  assert.equal(secondsToMicros('0.000001'),1n);
});
test('dirty lap time data is disregarded before clean-time validation and minimum selection',()=>{
  const payload=telemetry(challenge());
  payload.drivers[0].laps.unshift({is_clean:false,lap_time_seconds:'corrupt-time'},
    {is_clean:false,lap_time_seconds:{untrusted:true}},{is_clean:false});
  const parsed=Telemetry.parse(payload);
  assert.equal(decide(parsed).winnerId,A);
  assert.equal(decide(parsed).challengerBest,'60.000001');
});
