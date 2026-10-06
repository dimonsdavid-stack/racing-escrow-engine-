import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { T, P, A, B } from "./fixtures.js";
import { createApp } from "../src/app.js";
import { customerConfig } from "../src/customer.js";
const migration = new URL(
  "../supabase/migrations/20261005224115_customer_app.sql",
  import.meta.url,
);
test("public auth configuration rejects server secrets, service-role JWTs and unapproved origins", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    RACING_TENANT_ID: T,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  };
  assert.ok(customerConfig(env));
  for (const role of ["service_role", "authenticated"]) {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9." +
      Buffer.from(JSON.stringify({ role })).toString("base64url") +
      ".signature";
    assert.equal(
      customerConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: jwt }),
      null,
    );
  }
  assert.equal(
    customerConfig({
      ...env,
      SUPABASE_PUBLISHABLE_KEY: "sb_secret_server_only",
    }),
    null,
  );
  assert.equal(
    customerConfig({
      ...env,
      SUPABASE_URL: "https://example.supabase.co.attacker.test",
    }),
    null,
  );
  assert.equal(
    customerConfig({
      ...env,
      SUPABASE_URL: "https://user:password@example.supabase.co",
    }),
    null,
  );
});
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,is_anonymous boolean DEFAULT false);
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id));
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
INSERT INTO auth.users(id,email_confirmed_at) VALUES('${A}',now()),('${B}',now());
INSERT INTO auth.sessions VALUES('${A}','${A}'),('${B}','${B}');`);
  await db.exec(
    await readFile(new URL("../sql/001_engine.sql", import.meta.url), "utf8"),
  );
  await db.exec(await readFile(migration, "utf8"));
  await db.query(
    `INSERT INTO race_private.tenants(id,name,customer_signup_enabled) VALUES($1,'Customer tests',true)`,
    [T],
  );
  await db.query(
    `INSERT INTO race_private.providers(tenant_id,id) VALUES($1,$2)`,
    [T, P],
  );
  await db.query(
    `INSERT INTO race_private.tracks(tenant_id,id,title,provider_id,enabled) VALUES($1,'coastal','Coastal Sprint',$2,true)`,
    [T, P],
  );
  return db;
}
async function actor(db, id, session = id) {
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: id, session_id: session }),
  ]);
  await db.exec("SET ROLE authenticated");
}
async function rpc(db, name, args) {
  const placeholders = args.map((_, i) => "$" + (i + 1)).join(",");
  return (
    await db.query(`SELECT public.${name}(${placeholders}) AS result`, args)
  ).rows[0].result;
}
async function enroll(db, id, handle) {
  await actor(db, id);
  return rpc(db, "race_enroll", [T, handle, true]);
}
test("customer enrollment binds verified session identity and journals welcome and daily grants once", async () => {
  const db = await database();
  try {
    const a = await enroll(db, A, "Racer_A");
    assert.equal(a.duplicate, false);
    assert.equal((await enroll(db, A, "Racer_A")).duplicate, true);
    let me = await rpc(db, "race_state", [T]);
    assert.equal(me.gc_balance, "1000.000000");
    assert.equal(me.sc_balance, "0.000000");
    assert.equal(me.sc_eligible, false);
    const first = await rpc(db, "race_daily", [T]),
      replay = await rpc(db, "race_daily", [T]);
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    me = await rpc(db, "race_state", [T]);
    assert.equal(me.gc_balance, "1100.000000");
    assert.equal(me.history.length, 2);
    await actor(db, A, randomUUID());
    await assert.rejects(rpc(db, "race_state", [T]), /active_session_required/);
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1",
      [A],
    );
    await actor(db, A);
    await assert.rejects(
      rpc(db, "race_state", [T]),
      /verified_account_required/,
    );
  } finally {
    await db.close();
  }
});
test("offer acceptance locks both entries atomically; actor, terms, currencies and direct finance access are enforced", async () => {
  const db = await database();
  try {
    const a = await enroll(db, A, "Racer_A"),
      b = await enroll(db, B, "Racer_B");
    await actor(db, A);
    const id = randomUUID();
    assert.equal(
      (await rpc(db, "race_offer", [T, id, "coastal", "GC", "10.00"])).state,
      "Open",
    );
    assert.equal((await rpc(db, "race_state", [T])).gc_balance, "1000.000000");
    await assert.rejects(
      rpc(db, "race_accept", [T, id, true]),
      /offer_unavailable/,
    );
    await actor(db, B);
    await assert.rejects(
      rpc(db, "race_accept", [T, id, false]),
      /acceptance_required/,
    );
    const result = await rpc(db, "race_accept", [T, id, true]);
    assert.equal(result.status, "Active");
    assert.equal(result.pool, "20.000000");
    assert.equal((await rpc(db, "race_accept", [T, id, true])).duplicate, true);
    let me = await rpc(db, "race_state", [T]);
    assert.equal(me.gc_balance, "990.000000");
    assert.equal(me.races[0].opponent, "Racer_A");
    await assert.rejects(
      db.query("SELECT * FROM race_private.users"),
      /permission denied/,
    );
    await assert.rejects(
      rpc(db, "credit_wallet", [T, b.user_id, "GC", 1000, "forged"]),
      /permission denied/,
    );
    await actor(db, A);
    assert.equal((await rpc(db, "race_state", [T])).gc_balance, "990.000000");
    await assert.rejects(
      rpc(db, "race_offer", [T, randomUUID(), "coastal", "SC", "5.00"]),
      /play_or_currency_unavailable/,
    );
    await assert.rejects(
      rpc(db, "race_offer", [T, id, "coastal", "GC", "20.00"]),
      /offer_idempotency_conflict/,
    );
    await db.exec("RESET ROLE");
    const sum = await db.query(
      "SELECT sum(delta)::text AS total FROM race_private.journal_lines",
    );
    assert.equal(sum.rows[0].total, "0.000000");
    const escrow = await db.query(
      "SELECT remaining_escrow::text AS pool FROM race_private.challenges",
    );
    assert.equal(escrow.rows[0].pool, "20.000000");
  } finally {
    await db.close();
  }
});
test("failed funding, changed provider terms and participation pauses leave all funds intact", async () => {
  const db = await database();
  try {
    await enroll(db, A, "Racer_A");
    await enroll(db, B, "Racer_B");
    await actor(db, A);
    const id = randomUUID();
    await rpc(db, "race_offer", [T, id, "coastal", "GC", "1000.00"]);
    await actor(db, B);
    await rpc(db, "race_pause", [T, 24]);
    await assert.rejects(
      rpc(db, "race_accept", [T, id, true]),
      /play_or_currency_unavailable/,
    );
    const paused = (await rpc(db, "race_state", [T])).pause_until;
    await rpc(db, "race_pause", [T, 1]);
    assert.equal((await rpc(db, "race_state", [T])).pause_until, paused);
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE race_private.profiles SET pause_until=NULL WHERE tenant_id=$1",
      [T],
    );
    await db.query(
      "UPDATE race_private.tracks SET session_minutes=30 WHERE tenant_id=$1",
      [T],
    );
    await actor(db, B);
    await assert.rejects(
      rpc(db, "race_accept", [T, id, true]),
      /race_provider_or_terms_changed/,
    );
    assert.equal((await rpc(db, "race_state", [T])).gc_balance, "1000.000000");
    await actor(db, A);
    await rpc(db, "race_cancel", [T, id]);
    await actor(db, B);
    await assert.rejects(
      rpc(db, "race_accept", [T, id, true]),
      /offer_unavailable/,
    );
    await db.exec("RESET ROLE");
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM race_private.challenges"))
        .rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
test("customer REST verifies bearer identity, ignores body actor injection and passes only configured tenant to RPC", async () => {
  let calls = [];
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    RACING_TENANT_ID: T,
  };
  const makeClient = () => ({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: A,
            email_confirmed_at: "2026-01-01",
            is_anonymous: false,
          },
        },
      }),
    },
    rpc(name, args) {
      calls.push({ name, args });
      return {
        abortSignal() {
          return Promise.resolve({
            data: name==='grid_request_budget'?{allowed:true,retry_after:60}:{ status: "ok" },
            error: null,
            status: 200,
          });
        },
      };
    },
  });
  const server = createApp({
    customerOptions: { env, makeClient },
    log: () => {},
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin + "/api/v1/app/me")).status, 401);
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + "a".repeat(30),
    };
    let r = await fetch(origin + "/api/v1/app/offers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        request_id: randomUUID(),
        event_id: P,
        mode: "driver_duel",
        token_type: "GC",
        entry_fee: "10.00",
        user_id: B,
      }),
    });
    assert.equal(r.status, 422);
    assert.equal(calls.length, 0);
    r = await fetch(origin + "/api/v1/app/offers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        request_id: randomUUID(),
        event_id: P,
        mode: "driver_duel",
        token_type: "GC",
        entry_fee: "10.00",
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(calls[0].name,'grid_request_budget');
    assert.equal(calls[1].name, "sim_offer");
    assert.equal(calls[1].args.p_tenant_id, T);
    assert.equal(calls[1].args.p_user_id, undefined);
    const config = await (await fetch(origin + "/api/v1/app/config")).json();
    assert.equal(config.accounts_available, true);
    assert.equal(config.commerce_available, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
