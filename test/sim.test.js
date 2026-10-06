import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { T, P, A, B } from "./fixtures.js";
import {
  providerDecision,
  ProviderReport,
  normalizeACC,
  maskIRacingSecret,
  downloadURL,
  boundedJSON,
  IRacingDataClient,
} from "../src/providers.js";
import { encrypt, decrypt, hashPKCE } from "../src/oauth.js";
import { createCommerceRouter } from "../src/commerce.js";
import { handleInteraction, interactionUUID } from "../discord/bot.js";
import express from "express";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export async function simDatabase() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,is_anonymous boolean DEFAULT false);
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id));
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
INSERT INTO auth.users VALUES('${A}',now(),NULL,false),('${B}',now(),NULL,false);INSERT INTO auth.sessions VALUES('${A}','${A}'),('${B}','${B}');`);
  for (const f of [
    "sql/001_engine.sql",
    "supabase/migrations/20261005224115_customer_app.sql",
    "supabase/migrations/20261006073056_sim_racing_commerce.sql",
  ])
    await db.exec(await readFile(new URL("../" + f, import.meta.url), "utf8"));
  await db.query(
    `INSERT INTO race_private.tenants(id,name,customer_signup_enabled,sc_enabled,commerce_enabled) VALUES($1,'Sim test',true,true,true)`,
    [T],
  );
  await db.query(
    "INSERT INTO race_private.providers(tenant_id,id) VALUES($1,$2)",
    [T, P],
  );
  await actor(db, A);
  const a = await rpc(db, "race_enroll", [T, "Alice", true]);
  await actor(db, B);
  const b = await rpc(db, "race_enroll", [T, "Bob", true]);
  await db.exec("RESET ROLE");
  for (const [auth, id] of [
    [A, "123"],
    [B, "456"],
  ])
    await rpc(db, "sim_link_identity", [T, auth, "iracing", id]);
  await db.query(
    "INSERT INTO race_private.sim_events(tenant_id,id,provider_id,game,external_session_id,title,track_name,starts_at,funding_closes_at,deadline,rule,entrants) VALUES($1,$2,$3,'iracing','876','League race','Spa',now()+interval '30 minutes',now()+interval '25 minutes',now()+interval '2 hours','fastest_clean_lap','[\"123\",\"456\"]')",
    [T, E, P],
  );
  return { db, a: a.user_id, b: b.user_id };
}
async function actor(db, id) {
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: id, session_id: id }),
  ]);
  await db.exec("SET ROLE authenticated");
}
async function rpc(db, name, args) {
  return (
    await db.query(
      `SELECT public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) AS r`,
      args,
    )
  ).rows[0].r;
}
test("external sim consent binds identities and future event; replay does not fund twice and source evidence is atomic", async () => {
  const { db, a, b } = await simDatabase();
  try {
    const offer = randomUUID();
    await actor(db, A);
    await rpc(db, "sim_offer", [
      T,
      offer,
      E,
      "driver_duel",
      "GC",
      "10.00",
      null,
      b,
    ]);
    await assert.rejects(
      rpc(db, "sim_accept", [T, offer, true, null]),
      /offer_unavailable/,
    );
    await actor(db, B);
    await assert.rejects(
      rpc(db, "sim_accept", [T, offer, false, null]),
      /acceptance_required/,
    );
    const result = await rpc(db, "sim_accept", [T, offer, true, null]);
    assert.equal(result.pool, "20.000000");
    assert.equal(
      (await rpc(db, "sim_accept", [T, offer, true, null])).duplicate,
      true,
    );
    assert.equal((await rpc(db, "sim_state", [T])).gc_balance, "990.000000");
    await db.exec("RESET ROLE");
    await assert.rejects(
      rpc(db, "sim_link_identity", [T, B, "iracing", "789"]),
      /identity_locked/,
    );
    const scheduled = await rpc(db, "sim_result_context", [T, offer]);
    await assert.rejects(
      rpc(db, "sim_commit_result", [
        T,
        P,
        offer,
        "premature:" + offer,
        "876",
        "Spa",
        scheduled.starts_at,
        "f".repeat(64),
        "winner",
        "60",
        "62",
        {},
      ]),
      /historical_or_wrong_session/,
    );
    // Advance this scheduled-event fixture to an actual start after funding.
    await db.query(
      "UPDATE race_private.sim_events SET starts_at=clock_timestamp(),funding_closes_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
      [E],
    );
    const c = await rpc(db, "sim_result_context", [T, offer]);
    const args = [
      T,
      P,
      offer,
      "result:" + offer,
      "876",
      "Spa",
      c.starts_at,
      "a".repeat(64),
      "winner",
      "60",
      "62",
      { source_sha256: "a".repeat(64) },
    ];
    await assert.rejects(
      rpc(db, "sim_commit_result", [
        ...args.slice(0, 5),
        "Wrong track",
        ...args.slice(6),
      ]),
      /source_binding/,
    );
    assert.equal(
      (
        await db.query(
          "SELECT remaining_escrow::text AS n FROM race_private.challenges WHERE id=$1",
          [offer],
        )
      ).rows[0].n,
      "20.000000",
    );
    assert.equal((await rpc(db, "sim_commit_result", args)).winner_id, a);
    assert.equal((await rpc(db, "sim_commit_result", args)).duplicate, true);
    assert.equal(
      (
        await db.query(
          "SELECT gc_balance::text AS n FROM race_private.users WHERE id=$1",
          [a],
        )
      ).rows[0].n,
      "1008.000000",
    );
    assert.equal(
      (
        await db.query(
          "SELECT sum(delta)::text AS n FROM race_private.journal_lines",
        )
      ).rows[0].n,
      "0.000000",
    );
    await actor(db, B);
    await assert.rejects(
      db.query("SELECT * FROM race_private.driver_identities"),
      /permission denied/,
    );
    await assert.rejects(
      rpc(db, "sim_commit_result", args),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});
test("scheduled funding cutoff, payment review, and full zero-fee no-clean refunds are enforced", async () => {
  const { db } = await simDatabase();
  try {
    const offer = randomUUID();
    await actor(db, A);
    await rpc(db, "sim_offer", [
      T,
      offer,
      E,
      "driver_duel",
      "GC",
      "0.01",
      null,
      null,
    ]);
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE race_private.sim_events SET funding_closes_at=now()-interval '1 second' WHERE id=$1",
      [E],
    );
    await actor(db, B);
    await assert.rejects(
      rpc(db, "sim_accept", [T, offer, true, null]),
      /funding_closed/,
    );
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE race_private.sim_events SET funding_closes_at=now()+interval '25 minutes' WHERE id=$1",
      [E],
    );
    await actor(db, B);
    await rpc(db, "sim_accept", [T, offer, true, null]);
    await db.exec("RESET ROLE");
    // Advance this scheduled-event fixture to an actual start after funding.
    await db.query(
      "UPDATE race_private.sim_events SET starts_at=clock_timestamp(),funding_closes_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
      [E],
    );
    const c = await rpc(db, "sim_result_context", [T, offer]);
    const r = await rpc(db, "sim_commit_result", [
      T,
      P,
      offer,
      "refund:" + offer,
      "876",
      "Spa",
      c.starts_at,
      "b".repeat(64),
      "no_clean_laps",
      null,
      null,
      {},
    ]);
    assert.equal(r.refund_per_user, "0.010000");
    assert.equal(r.rake_charged, "0");
    assert.ok(
      (
        await db.query("SELECT gc_balance::text AS n FROM race_private.users")
      ).rows.every((r) => r.n === "1000.000000"),
    );
  } finally {
    await db.close();
  }
});
test("payment receipt and both coin grants commit once; failed SC grant rolls GC and receipt back", async () => {
  const { db, a } = await simDatabase();
  try {
    await db.query(
      "UPDATE race_private.profiles SET sc_eligible=true WHERE tenant_id=$1",
      [T],
    );
    await db.query(
      "INSERT INTO race_private.commerce_catalog VALUES($1,'pack_bronze_10',1000,10000,10,true)",
      [T],
    );
    const id = randomUUID();
    await actor(db, A);
    await rpc(db, "sim_create_order", [T, id, "pack_bronze_10"]);
    await db.exec("RESET ROLE");
    await db.query(
      "UPDATE race_private.tenants SET sc_enabled=false WHERE id=$1",
      [T],
    );
    const args = [T, id, "cs_test_123", "pi_123", "evt_123", 1000, "usd"];
    await assert.rejects(
      rpc(db, "fulfill_coin_purchase", args),
      /currency_disabled/,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM race_private.payment_ledgers",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT gc_balance::text AS n FROM race_private.users WHERE id=$1",
          [a],
        )
      ).rows[0].n,
      "1000.000000",
    );
    await db.query(
      "UPDATE race_private.tenants SET sc_enabled=true WHERE id=$1",
      [T],
    );
    assert.equal(
      (await rpc(db, "fulfill_coin_purchase", args)).duplicate,
      false,
    );
    assert.equal(
      (await rpc(db, "fulfill_coin_purchase", args)).duplicate,
      true,
    );
    await assert.rejects(
      rpc(db, "fulfill_coin_purchase", [...args.slice(0, 5), 2000, "usd"]),
      /payment_conflict/,
    );
    const u = (
      await db.query(
        "SELECT gc_balance::text AS gc,sc_balance::text AS sc FROM race_private.users WHERE id=$1",
        [a],
      )
    ).rows[0];
    assert.deepEqual(u, { gc: "11000.000000", sc: "10.000000" });
    await rpc(db, "sim_payment_review", [
      "evt_refund",
      "pi_123",
      "charge.refunded",
    ]);
    await actor(db, A);
    await assert.rejects(
      rpc(db, "sim_offer", [
        T,
        randomUUID(),
        E,
        "driver_duel",
        "GC",
        "10",
        null,
        null,
      ]),
      /account_review/,
    );
  } finally {
    await db.close();
  }
});
test("OAuth state is one-use; token refresh has a durable exclusive lease and CAS completion", async () => {
  const { db } = await simDatabase();
  try {
    const state = createHash("sha256").update("x").digest("hex");
    await rpc(db, "sim_oauth_begin", [T, A, "iracing", state, "encrypted"]);
    assert.equal(
      (await rpc(db, "sim_oauth_consume", [state, "iracing"])).auth_user_id,
      A,
    );
    await assert.rejects(
      rpc(db, "sim_oauth_consume", [state, "iracing"]),
      /replayed_oauth/,
    );
    await rpc(db, "sim_store_token", [
      T,
      A,
      "old",
      new Date(Date.now() + 1000).toISOString(),
    ]);
    const lease = await rpc(db, "sim_token_lease", [T, A]);
    assert.equal(lease.mode, "refresh");
    assert.equal((await rpc(db, "sim_token_lease", [T, A])).mode, "busy");
    const args = [
      T,
      A,
      lease.lease,
      lease.version,
      "new",
      new Date(Date.now() + 3600000).toISOString(),
    ];
    assert.equal(await rpc(db, "sim_token_commit", args), true);
    assert.equal(await rpc(db, "sim_token_commit", args), true);
    assert.equal((await rpc(db, "sim_token_lease", [T, A])).mode, "access");
  } finally {
    await db.close();
  }
});
test("provider minima ignore dirty, zero and negative laps, preserve microseconds, tie and disconnect refund", () => {
  const context = {
    event_id: E,
    external_session_id: "876",
    track_name: "Spa",
    selection_a: "123",
    selection_b: "456",
    rule: "fastest_clean_lap",
  };
  const report = {
    event_id: E,
    external_session_id: "876",
    track_name: "Spa",
    race_status: "completed",
    drivers: [
      {
        external_id: "123",
        laps: [
          { is_clean: false, lap_time_seconds: "1" },
          { is_clean: true, lap_time_seconds: "0" },
          { is_clean: true, lap_time_seconds: "-2" },
          { is_clean: true, lap_time_seconds: "60.000001" },
        ],
      },
      {
        external_id: "456",
        laps: [{ is_clean: true, lap_time_seconds: "60.000002" }],
      },
    ],
  };
  assert.deepEqual(providerDecision(report, context), {
    resolution: "winner",
    best_a: "60.000001",
    best_b: "60.000002",
  });
  report.drivers[1].laps = [];
  report.drivers[0].laps = [];
  assert.equal(providerDecision(report, context).resolution, "no_clean_laps");
  report.race_status = "network_drop";
  assert.equal(providerDecision(report, context).resolution, "network_drop");
  report.race_status = "completed";
  report.drivers.pop();
  assert.throws(() => providerDecision(report, context), /incomplete_driver/);
});
test("ACC ownership mapping requires explicit lap validity and unambiguous team driver evidence", () => {
  const binding = {
    challenge_id: A,
    event_id: E,
    source_id: "acc:1",
    external_session_id: "session-1",
    track_name: "Spa",
    actual_start: new Date().toISOString(),
  };
  const source = {
    metaData: "session-1",
    trackName: "Spa",
    sessionResult: {
      leaderBoardLines: [
        { car: { carId: 1, drivers: [{ playerId: "steam_123" }] } },
      ],
    },
    laps: [{ carId: 1, lapTime: 60001, isValidForBest: true }],
  };
  assert.equal(
    normalizeACC(source, binding).drivers[0].laps[0].lap_time_seconds,
    "60.001000",
  );
  delete source.laps[0].isValidForBest;
  assert.throws(() => normalizeACC(source, binding), /ambiguous_lap/);
});
test("official iRacing masking vector, AES-GCM tamper rejection and download URL restrictions", () => {
  assert.equal(
    maskIRacingSecret(
      "Anagram-tactics-FOOTING-OPACITY-SHONE-keenly",
      " John.West@iracing.com ",
    ),
    "KIhAi2ynNPWvJsebdluGaBaPTRaUACqTPDCfyUuv46Y=",
  );
  const env = { OAUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
    encoded = encrypt("refresh-token", env);
  assert.equal(decrypt(encoded, env), "refresh-token");
  assert.throws(() => decrypt(encoded.slice(0, -5) + "AAAAA", env));
  assert.equal(hashPKCE("test").length, 43);
  const hosts = new Set(["approved.s3.amazonaws.com"]);
  for (const url of [
    "http://approved.s3.amazonaws.com/file",
    "https://approved.s3.amazonaws.com.attacker.test",
    "https://secret@approved.s3.amazonaws.com/file",
    "https://127.0.0.1/",
  ])
    assert.throws(() => downloadURL(url, hosts));
});
test("Stripe unpaid completion cannot credit coins; paid event uses authoritative order and one RPC", async () => {
  const calls = [];
  let paid = false;
  const client = {
    rpc: (name, args) => ({
      abortSignal: async () => {
        calls.push({ name, args });
        return { data: {}, error: null, status: 200 };
      },
    }),
  };
  const stripe = {
    webhooks: {
      constructEvent: () => ({
        id: "evt_123",
        type: "checkout.session.completed",
        data: { object: { id: "cs_test_123" } },
      }),
    },
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: "cs_test_123",
          metadata: { tenant_id: T, order_id: A },
          mode: "payment",
          payment_status: paid ? "paid" : "unpaid",
          currency: "usd",
          amount_total: 1000,
          payment_intent: "pi_123",
        }),
      },
    },
  };
  const server = express()
    .use(
      createCommerceRouter({
        client,
        stripe,
        env: { STRIPE_WEBHOOK_SECRET: "whsec_test" },
      }),
    )
    .listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = () =>
      fetch(origin + "/api/v1/stripe/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "test",
        },
        body: "{}",
      });
    assert.equal((await send()).status, 200);
    assert.equal(calls.length, 0);
    paid = true;
    assert.equal((await send()).status, 200);
    assert.equal(calls[0].name, "fulfill_coin_purchase");
    assert.equal(calls[0].args.p_amount_paid_cents, 1000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("Discord accept rejects a different player before any backend request and keeps stable retry IDs", async () => {
  let calls = 0,
    reply;
  await handleInteraction(
    {
      isButton: () => true,
      customId: `accept_${A}_123456789012345678`,
      user: { id: "987654321098765432" },
      reply: async (v) => {
        reply = v.content;
      },
    },
    {},
    async () => {
      calls++;
    },
  );
  assert.equal(calls, 0);
  assert.match(reply, /Only the invited/);
  assert.equal(interactionUUID("123"), interactionUUID("123"));
});

test("trusted ACC bridge submits source-file-bound reports and never accepts a mismatched session log", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { submitACC } = await import("../server/acc-bridge.js");
  const dir = await mkdtemp(join(tmpdir(), "acc-bridge-"));
  try {
    const result = {
      metaData: "session-acc",
      trackName: "Spa",
      sessionResult: {
        leaderBoardLines: [
          { car: { carId: 1, drivers: [{ playerId: "steam_123" }] } },
          { car: { carId: 2, drivers: [{ playerId: "steam_456" }] } },
        ],
      },
      laps: [
        { carId: 1, lapTime: 60001, isValidForBest: true },
        { carId: 2, lapTime: 62001, isValidForBest: true },
      ],
    };
    await writeFile(join(dir, "result.json"), JSON.stringify(result));
    await writeFile(
      join(dir, "log.json"),
      JSON.stringify({
        external_session_id: "session-acc",
        actual_start: "2026-10-06T16:00:00Z",
      }),
    );
    const reports = [];
    const context = {
      game: "acc",
      challenge_id: A,
      event_id: E,
      external_session_id: "session-acc",
      track_name: "Spa",
    };
    const post = async (path, body) => {
      if (path.endsWith("/contracts")) return [context];
      reports.push(body);
      return { status: "Settled" };
    };
    assert.deepEqual(
      await submitACC(
        join(dir, "result.json"),
        join(dir, "log.json"),
        {},
        post,
      ),
      { submitted: 1 },
    );
    assert.equal(reports[0].drivers[0].laps[0].lap_time_seconds, "60.001000");
    await submitACC(join(dir, "result.json"), join(dir, "log.json"), {}, post);
    assert.deepEqual(reports[0], reports[1]);
    await writeFile(
      join(dir, "log.json"),
      JSON.stringify({
        external_session_id: "different",
        actual_start: "2026-10-06T16:00:00Z",
      }),
    );
    await assert.rejects(
      submitACC(join(dir, "result.json"), join(dir, "log.json"), {}, post),
      /session_log_binding/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
