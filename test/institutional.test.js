import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { T, T2, P, A, B } from "./fixtures.js";
import { verifyAuditRecords, exportWalletAudit } from "../src/audit.js";
import { createApp } from "../src/app.js";
import { signBody } from "../src/signature.js";
import { providerDecision } from "../src/providers.js";
const files = [
  "sql/001_engine.sql",
  "supabase/migrations/20261005224115_customer_app.sql",
  "supabase/migrations/20261006073056_sim_racing_commerce.sql",
  "supabase/migrations/20261006092644_institutional_controls.sql",
];
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function rpc(db, name, args) {
  return (
    await db.query(
      `SELECT public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) AS r`,
      args,
    )
  ).rows[0].r;
}
async function actor(db, id) {
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: id, session_id: id }),
  ]);
  await db.exec("SET ROLE authenticated");
}
async function service(db) {
  await db.exec("RESET ROLE;SET ROLE service_role");
}
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,is_anonymous boolean DEFAULT false);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id));
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    CREATE SCHEMA realtime;CREATE TABLE realtime.messages(payload jsonb,event text,topic text,private boolean,extension text DEFAULT 'broadcast');
    ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;GRANT USAGE ON SCHEMA realtime TO authenticated;GRANT SELECT,INSERT ON realtime.messages TO authenticated;CREATE POLICY unrelated_app_read ON realtime.messages FOR SELECT TO authenticated USING(true);CREATE POLICY unrelated_app_write ON realtime.messages FOR INSERT TO authenticated WITH CHECK(true);
    CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$SELECT current_setting('realtime.topic',true)$$;
    CREATE FUNCTION realtime.send(jsonb,text,text,boolean) RETURNS void LANGUAGE sql AS $$INSERT INTO realtime.messages(payload,event,topic,private) VALUES($1,$2,$3,$4)$$;`);
  for (const f of files)
    await db.exec(await readFile(new URL("../" + f, import.meta.url), "utf8"));
  await db.query(
    "INSERT INTO race_private.tenants(id,name,enabled,customer_signup_enabled,sc_enabled,commerce_enabled) VALUES($1,'Institutional test',true,true,true,true),($2,'Separate tenant',true,true,true,false)",
    [T, T2],
  );
  await db.query(
    "INSERT INTO race_private.providers(tenant_id,id) VALUES($1,$2)",
    [T, P],
  );
  const wallets = {};
  for (const [id, name] of [
    [A, "Alice"],
    [B, "Bob"],
    [C, "Charlie"],
  ]) {
    await db.exec("RESET ROLE");
    await db.query(
      "INSERT INTO auth.users(id,email_confirmed_at) VALUES($1,now());",
      [id],
    );
    await db.query("INSERT INTO auth.sessions VALUES($1,$1)", [id]);
    await actor(db, id);
    wallets[id] = (await rpc(db, "race_enroll", [T, name, true])).user_id;
    await service(db);
    await rpc(db, "sim_link_identity", [
      T,
      id,
      "iracing",
      id === A ? "123" : id === B ? "456" : "789",
    ]);
  }
  await service(db);
  const program = randomUUID();
  await rpc(db, "grid_publish_program", [
    T,
    P,
    randomUUID(),
    program,
    "rules-2026",
    "Test-only promotion",
    "Test sponsor",
    "https://rules.example.test/official",
    "c".repeat(64),
    new Date(Date.now() - 3600000).toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
    21,
    ["US-CA"],
    "1.000000",
    24,
    1,
    "Test authorization record",
    "a".repeat(64),
  ]);
  await rpc(db, "grid_activate_program", [
    T,
    P,
    randomUUID(),
    program,
    true,
    "Test authorization record",
    "b".repeat(64),
  ]);
  return { db, wallets, program };
}
async function receipt(db, auth, purpose, overrides = {}) {
  await service(db);
  const observed = new Date(Date.now() - 1000).toISOString(),
    expires = new Date(
      Date.now() + (purpose === "identity" ? 86400000 : 120000),
    ).toISOString();
  const data = {
    receipt: randomUUID(),
    auth,
    purpose,
    decision: "approved",
    reason: "provider_verified",
    observed,
    expires,
    subject:
      purpose === "identity"
        ? createHash("sha256").update(auth).digest("hex")
        : null,
    age: purpose === "identity" ? 21 : null,
    territory: purpose === "location" ? "US-CA" : null,
    proxy: false,
    sha: randomBytes(32).toString("hex"),
    ...overrides,
  };
  return rpc(db, "grid_record_compliance", [T, P, ...Object.values(data)]);
}
async function eligible(db, auth, program) {
  await receipt(db, auth, "identity");
  await receipt(db, auth, "location");
  await actor(db, auth);
  await rpc(db, "grid_consent", [T, program]);
}
function client(db) {
  return {
    rpc(name, args) {
      return {
        abortSignal() {
          return rpc(db, name, Object.values(args)).then((data) => ({
            data,
            error: null,
            status: 200,
          }));
        },
      };
    },
  };
}

test("institutional controls enforce free entry, evidence, isolation and journal integrity", async (t) => {
  const { db, wallets, program } = await database();
  try {
    await t.test(
      "anonymous rules contain no wallets; customers cannot forge KYC, policy or financial writes",
      async () => {
        await db.exec("RESET ROLE;SET ROLE anon");
        assert.equal((await rpc(db, "grid_program", [T])).program.id, program);
        assert.equal((await rpc(db, "grid_program", [T2])).program, null);
        await assert.rejects(
          db.query("SELECT * FROM race_private.users"),
          /permission denied/,
        );
        await actor(db, A);
        await assert.rejects(
          rpc(db, "grid_record_compliance", [
            T,
            P,
            randomUUID(),
            A,
            "identity",
            "approved",
            "fraud",
            new Date().toISOString(),
            new Date(Date.now() + 3600000).toISOString(),
            "a".repeat(64),
            21,
            null,
            false,
            "a".repeat(64),
          ]),
          /permission denied/,
        );
        await assert.rejects(
          rpc(db, "grid_activate_program", [
            T,
            P,
            randomUUID(),
            program,
            false,
            "Fake approval record",
            "a".repeat(64),
          ]),
          /permission denied/,
        );
        assert.equal((await rpc(db, "grid_compliance", [T])).eligible, false);
        const r = await rpc(db, "grid_ame", [T, randomUUID(), program]);
        assert.equal(r.state, "Rejected");
        assert.equal(r.amount, "0.000000");
        assert.equal((await rpc(db, "sim_state", [T])).sc_balance, "0.000000");
        await assert.rejects(
          rpc(db, "grid_compliance", [T2]),
          /profile_required/,
        );
      },
    );
    await t.test(
      "verified free entry credits once, logs its receipt and shares the same eligibility as SC funding",
      async () => {
        await eligible(db, A, program);
        await actor(db, A);
        assert.equal((await rpc(db, "sim_state", [T])).sc_eligible, true);
        const request = randomUUID(),
          first = await rpc(db, "grid_ame", [T, request, program]),
          again = await rpc(db, "grid_ame", [T, request, program]);
        assert.equal(first.state, "Credited");
        assert.equal(first.amount, "1.000000");
        assert.equal(again.duplicate, true);
        assert.equal(first.journal_id, again.journal_id);
        const capped = await rpc(db, "grid_ame", [T, randomUUID(), program]);
        assert.equal(capped.reason, "period_limit_reached");
        assert.equal(capped.state, "Rejected");
        const me = await rpc(db, "sim_state", [T]);
        assert.equal(me.gc_balance, "1000.000000");
        assert.equal(me.sc_balance, "1.000000");
        const c = await rpc(db, "grid_compliance", [T]);
        assert.equal(c.entries_remaining, 0);
        assert.equal(
          c.requests.filter((x) => x.state === "Credited").length,
          1,
        );
        await actor(db, B);
        await assert.rejects(
          rpc(db, "grid_ame", [T, request, program]),
          /ame_idempotency_conflict/,
        );
      },
    );
    await t.test(
      "expired location is rejected while account reads remain available",
      async () => {
        await receipt(db, A, "location", {
          observed: new Date(Date.now() - 500).toISOString(),
          expires: new Date(Date.now() - 100).toISOString(),
        });
        await actor(db, A);
        assert.equal(
          (await rpc(db, "grid_compliance", [T])).reason,
          "location_verification_required",
        );
        assert.equal((await rpc(db, "sim_state", [T])).sc_eligible, false);
        assert.equal(
          (await rpc(db, "grid_ame", [T, randomUUID(), program])).state,
          "Rejected",
        );
        await receipt(db, A, "location", {
          observed: new Date().toISOString(),
        });
      },
    );
    await t.test(
      "reusing a verified identity opens a durable review, including for GC actions",
      async () => {
        const proof = await receipt(db, B, "identity", {
          subject: createHash("sha256").update(A).digest("hex"),
        });
        assert.equal(proof.decision, "review");
        await actor(db, B);
        await assert.rejects(
          rpc(db, "race_daily", [T]),
          /play_or_currency_unavailable/,
        );
        await db.exec("RESET ROLE");
        const review = (
          await db.query(
            "SELECT id FROM race_private.risk_cases WHERE user_id=$1",
            [wallets[B]],
          )
        ).rows[0].id;
        await service(db);
        assert.equal(
          (
            await rpc(db, "grid_resolve_review", [
              T,
              P,
              review,
              "Identity review completed by test analyst",
              "e".repeat(64),
            ])
          ).resolved,
          true,
        );
        await receipt(db, B, "identity", {
          observed: new Date().toISOString(),
        });
        await receipt(db, B, "location");
        await actor(db, B);
        await rpc(db, "grid_consent", [T, program]);
        assert.equal((await rpc(db, "grid_compliance", [T])).eligible, true);
      },
    );
    await t.test(
      "a denied risk assertion blocks both GC and SC until recorded review",
      async () => {
        await receipt(db, C, "risk", {
          decision: "denied",
          reason: "vendor_fraud_denial",
        });
        await actor(db, C);
        await assert.rejects(
          rpc(db, "race_daily", [T]),
          /play_or_currency_unavailable/,
        );
        assert.equal(
          (await rpc(db, "grid_compliance", [T])).reason,
          "account_review",
        );
      },
    );
    await t.test(
      "journal chains are verifiable, immutable, sealed against additional lines and isolate tenants",
      async () => {
        await service(db);
        const exported = await exportWalletAudit(client(db), T, wallets[A]);
        assert.ok(exported.records.length >= 2);
        assert.equal(
          verifyAuditRecords(exported.records, {
            tenantId: T,
            userId: wallets[A],
          }).hash,
          exported.checkpoint.hash,
        );
        const altered = structuredClone(exported.records);
        altered[0].canonical_payload = altered[0].canonical_payload.replace(
          "1000.000000",
          "2000.000000",
        );
        assert.throws(
          () =>
            verifyAuditRecords(altered, { tenantId: T, userId: wallets[A] }),
          /audit_chain_hash_failed/,
        );
        assert.throws(
          () =>
            verifyAuditRecords(exported.records, {
              tenantId: T2,
              userId: wallets[A],
            }),
          /binding_failed/,
        );
        await db.exec("RESET ROLE");
        await assert.rejects(
          db.query("UPDATE race_private.audit_records SET hash=$1", [
            "a".repeat(64),
          ]),
          /append_only_record/,
        );
        await assert.rejects(
          db.query(
            "INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta) VALUES($1,$2,'User',$3,1)",
            [T, exported.records[0].transaction_id, wallets[A]],
          ),
          /sealed_journal/,
        );
        assert.equal(
          (
            await db.query(
              "SELECT sum(delta)::text AS total FROM race_private.journal_lines",
            )
          ).rows[0].total,
          "0.000000",
        );
      },
    );
    await t.test(
      "deferred audit failure rolls back the wallet, grant journal and audit head together",
      async () => {
        await db.exec("RESET ROLE");
        const before = (
          await db.query(
            "SELECT gc_balance::text AS balance FROM race_private.users WHERE id=$1",
            [wallets[A]],
          )
        ).rows[0].balance;
        const head = (
          await db.query(
            "SELECT sequence::text AS n FROM race_private.audit_heads WHERE user_id=$1",
            [wallets[A]],
          )
        ).rows[0].n;
        await db.exec(
          "CREATE FUNCTION race_private.audit_disk_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit_storage_failure';END$$;CREATE TRIGGER audit_disk_failure BEFORE INSERT ON race_private.audit_records FOR EACH ROW EXECUTE FUNCTION race_private.audit_disk_failure();",
        );
        await service(db);
        await assert.rejects(
          rpc(db, "credit_wallet", [
            T,
            wallets[A],
            "GC",
            "10",
            "atomic-audit-test",
          ]),
          /audit_storage_failure/,
        );
        await db.exec(
          "RESET ROLE;DROP TRIGGER audit_disk_failure ON race_private.audit_records",
        );
        assert.equal(
          (
            await db.query(
              "SELECT gc_balance::text AS balance FROM race_private.users WHERE id=$1",
              [wallets[A]],
            )
          ).rows[0].balance,
          before,
        );
        assert.equal(
          (
            await db.query(
              "SELECT sequence::text AS n FROM race_private.audit_heads WHERE user_id=$1",
              [wallets[A]],
            )
          ).rows[0].n,
          head,
        );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM race_private.journal_transactions WHERE external_ref='atomic-audit-test'",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "private wallet topics reject other users, revoked sessions and public broadcasts",
      async () => {
        await actor(db, A);
        await db.query("SELECT set_config('realtime.topic',$1,false)", [
          "gridstake-wallet:" + T + ":" + A,
        ]);
        assert.ok(
          (await db.query("SELECT payload FROM realtime.messages")).rows
            .length > 0,
        );
        assert.ok(
          (await db.query("SELECT payload FROM realtime.messages")).rows.every(
            (x) => JSON.stringify(x.payload) === '{"refresh":true}',
          ),
        );
        await db.query("SELECT set_config('realtime.topic',$1,false)", [
          "gridstake-wallet:" + T + ":" + B,
        ]);
        assert.equal(
          (await db.query("SELECT * FROM realtime.messages")).rows.length,
          0,
        );
        await assert.rejects(
          db.query(
            "INSERT INTO realtime.messages VALUES('{}','wallet_changed','gridstake-wallet:fake',true,'broadcast')",
          ),
          /row-level security/,
        );
        await db.exec("RESET ROLE");
        await db.query("DELETE FROM auth.sessions WHERE id=$1", [C]);
        await actor(db, C);
        await db.query("SELECT set_config('realtime.topic',$1,false)", [
          "gridstake-wallet:" + T + ":" + C,
        ]);
        assert.equal(
          (await db.query("SELECT * FROM realtime.messages")).rows.length,
          0,
        );
      },
    );
    await t.test(
      "request admission budgets and immutable catalog cannot be client-increased",
      async () => {
        await actor(db, A);
        let last;
        for (let i = 0; i < 6; i++)
          last = await rpc(db, "grid_request_budget", [T, "checkout"]);
        assert.equal(last.allowed, false);
        await assert.rejects(
          rpc(db, "grid_request_budget", [T, "unlimited"]),
          /invalid_budget/,
        );
        await service(db);
        await rpc(db, "grid_install_catalog", [T]);
        await db.exec("RESET ROLE");
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM race_private.commerce_catalog WHERE tenant_id=$1",
              [T],
            )
          ).rows[0].n,
          3,
        );
        await assert.rejects(
          db.query(
            "UPDATE race_private.commerce_catalog SET gc=gc+1 WHERE tenant_id=$1",
            [T],
          ),
          /catalog_terms_immutable/,
        );
      },
    );
    await t.test(
      "atomic funding and source-bound settlement ignore forged payout values and refund dirty races fully",
      async () => {
        await db.exec("RESET ROLE");
        const event = randomUUID();
        await db.query(
          "INSERT INTO race_private.sim_events(tenant_id,id,provider_id,game,external_session_id,title,track_name,starts_at,funding_closes_at,deadline,rule,entrants,min_lap_seconds,max_lap_seconds) VALUES($1,$2,$3,'iracing','777','Test race','Spa',now()+interval '30 minutes',now()+interval '20 minutes',now()+interval '2 hours','fastest_clean_lap','[\"123\",\"456\"]',50,180)",
          [T, event, P],
        );
        const offer = randomUUID();
        await actor(db, A);
        await rpc(db, "sim_offer", [
          T,
          offer,
          event,
          "driver_duel",
          "GC",
          "10.00",
          null,
          wallets[B],
        ]);
        await actor(db, B);
        assert.equal(
          (await rpc(db, "execute_p2p_escrow", [offer])).status,
          "Active",
        );
        await service(db);
        await assert.rejects(
          rpc(db, "commit_challenge_settlement", [
            offer,
            wallets[A],
            "999",
            "GC",
            "777",
          ]),
          /authoritative_evidence_required/,
        );
        await db.exec("RESET ROLE");
        await db.query(
          "UPDATE race_private.sim_events SET starts_at=clock_timestamp(),funding_closes_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
          [event],
        );
        const context = await rpc(db, "sim_result_context", [T, offer]);
        assert.equal(context.min_lap_seconds, "50.000000");
        await service(db);
        const args = [
          T,
          P,
          offer,
          "test:" + offer,
          "777",
          "Spa",
          context.starts_at,
          "d".repeat(64),
          "winner",
          "60",
          "62",
          {},
        ];
        await assert.rejects(
          rpc(db, "sim_commit_result", [
            ...args.slice(0, 9),
            "0.000001",
            "62",
            {},
          ]),
          /lap_outside_registered_bounds/,
        );
        const result = await rpc(db, "sim_commit_result", args);
        assert.equal(result.winner_payout, "18.000000");
        assert.equal(result.status, "Settled");
        await assert.rejects(
          rpc(db, "commit_challenge_settlement", [
            offer,
            wallets[A],
            "20",
            "GC",
            "777",
          ]),
          /settlement_terms_mismatch/,
        );
        assert.equal(
          (
            await rpc(db, "commit_challenge_settlement", [
              offer,
              wallets[A],
              "18",
              "GC",
              "777",
            ])
          ).duplicate,
          true,
        );
        await db.exec("RESET ROLE");
        const event2 = randomUUID();
        await db.query(
          "INSERT INTO race_private.sim_events(tenant_id,id,provider_id,game,external_session_id,title,track_name,starts_at,funding_closes_at,deadline,rule,entrants) VALUES($1,$2,$3,'iracing','778','Dirty race','Spa',now()+interval '30 minutes',now()+interval '20 minutes',now()+interval '2 hours','fastest_clean_lap','[\"123\",\"456\"]')",
          [T, event2, P],
        );
        const dirty = randomUUID();
        await actor(db, A);
        await rpc(db, "sim_offer", [
          T,
          dirty,
          event2,
          "driver_duel",
          "GC",
          "10.00",
          null,
          wallets[B],
        ]);
        await actor(db, B);
        await rpc(db, "execute_p2p_escrow", [dirty]);
        await db.exec("RESET ROLE");
        await db.query(
          "UPDATE race_private.sim_events SET starts_at=clock_timestamp(),funding_closes_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
          [event2],
        );
        const context2 = await rpc(db, "sim_result_context", [T, dirty]);
        await service(db);
        const refund = await rpc(db, "sim_commit_result", [
          T,
          P,
          dirty,
          "dirty:" + dirty,
          "778",
          "Spa",
          context2.starts_at,
          "f".repeat(64),
          "no_clean_laps",
          null,
          null,
          {},
        ]);
        assert.equal(refund.status, "Refunded");
        assert.equal(refund.rake_charged, "0");
        assert.equal(refund.refund_per_user, "10.000000");
      },
    );
  } finally {
    await db.close();
  }
});

test("signed compliance ingress binds tenant and purpose; untrusted origins and replay paths are refused", async () => {
  const secret = randomBytes(32),
    keys = new Map([["kyc", { tenantId: T, providerId: P, secret }]]),
    calls = [];
  const backend = {
    rpc(name, args) {
      calls.push({ name, args });
      return {
        abortSignal() {
          return Promise.resolve({
            data: { decision: "approved" },
            error: null,
            status: 200,
          });
        },
      };
    },
  };
  const server = createApp({
    client: backend,
    complianceKeys: keys,
    env: { APP_ORIGIN: "https://gridstake.example", NODE_ENV: "production" },
    log: () => {},
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const origin = "http://127.0.0.1:" + server.address().port,
      path = "/api/v1/compliance/receipts",
      now = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from(
      JSON.stringify({
        receipt_id: randomUUID(),
        auth_user_id: A,
        purpose: "identity",
        decision: "approved",
        reason: "kyc_verified",
        observed_at: new Date().toISOString(),
        valid_until: new Date(Date.now() + 86400000).toISOString(),
        subject_key: "a".repeat(64),
        age_threshold: 21,
        proxy_detected: false,
      }),
    );
    const headers = {
      "Content-Type": "application/json",
      "X-Telemetry-Key-Id": "kyc",
      "X-Telemetry-Timestamp": now,
      "X-Telemetry-Signature": signBody(secret, "kyc", now, body, path),
    };
    assert.equal(
      (await fetch(origin + path, { method: "POST", headers, body })).status,
      200,
    );
    assert.equal(calls[0].args.p_tenant_id, T);
    assert.equal(calls[0].args.p_provider_id, P);
    assert.equal(calls[0].args.p_auth_user_id, A);
    assert.equal(
      calls[0].args.p_payload_sha256,
      createHash("sha256").update(body).digest("hex"),
    );
    assert.equal(
      (
        await fetch(origin + path, {
          method: "POST",
          headers: { ...headers, Origin: "https://attacker.example" },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/v1/compliance/reviews/resolve", {
          method: "POST",
          headers,
          body,
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await fetch(origin + path, {
          method: "POST",
          headers: { ...headers, "X-Telemetry-Signature": "0".repeat(64) },
          body,
        })
      ).status,
      401,
    );
    const preflight = await fetch(origin + "/api/v1/app/me", {
      method: "OPTIONS",
      headers: {
        Origin: "https://gridstake.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://gridstake.example",
    );
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("lap flags and registered bounds discard suspicious metrics without using them as the minimum", () => {
  const context = {
    event_id: P,
    external_session_id: "777",
    track_name: "Spa",
    rule: "fastest_clean_lap",
    selection_a: "123",
    selection_b: "456",
    min_lap_seconds: "50",
    max_lap_seconds: "180",
  };
  const report = {
    event_id: P,
    external_session_id: "777",
    track_name: "Spa",
    race_status: "completed",
    drivers: [
      {
        external_id: "123",
        laps: [
          { is_clean: true, flags: 128, lap_time_seconds: "51" },
          { is_clean: true, lap_time_seconds: "0.000001" },
          { is_clean: true, lap_time_seconds: "181" },
          { is_clean: true, flags: 0, lap_time_seconds: "60.000001" },
        ],
      },
      {
        external_id: "456",
        laps: [{ is_clean: true, lap_time_seconds: "62" }],
      },
    ],
  };
  assert.equal(providerDecision(report, context).best_a, "60.000001");
  assert.equal(
    providerDecision(
      {
        ...report,
        drivers: report.drivers.map((d) => ({
          ...d,
          laps: d.laps.filter((l) => l.lap_time_seconds === "0.000001"),
        })),
      },
      context,
    ).resolution,
    "no_clean_laps",
  );
});
