import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLogger } from '../src/logging.js';

test('asynchronous logging rejection is handled before it can terminate the service',async()=>{
  let received;
  const write=safeLogger(async record=>{
    received=record;
    throw new Error('async_sink_unavailable');
  });
  const record={event:'settlement_committed'};
  assert.equal(write(record),undefined);
  await new Promise(resolve=>setImmediate(resolve));
  assert.strictEqual(received,record);
});
