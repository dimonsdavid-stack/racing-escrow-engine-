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
  "supabase/migrations/20261006112856_cash_redemption.sql",
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
    "5.000000",
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

async function challenge(db, wallets, token, fee, resolution = "winner") {
  await db.exec("RESET ROLE");
  const event = randomUUID(),
    offer = randomUUID(),
    session = String(Math.floor(Math.random() * 1000000000));
  await db.query(
    "INSERT INTO race_private.sim_events(tenant_id,id,provider_id,game,external_session_id,title,track_name,starts_at,funding_closes_at,deadline,rule,entrants,min_lap_seconds,max_lap_seconds) VALUES($1,$2,$3,'iracing',$4,'Cash test race','Spa',now()+interval '30 minutes',now()+interval '20 minutes',now()+interval '2 hours','fastest_clean_lap','[\"123\",\"456\"]',50,180)",
    [T, event, P, session],
  );
  await actor(db, A);
  await rpc(db, "sim_offer", [
    T,
    offer,
    event,
    "driver_duel",
    token,
    fee,
    null,
    wallets[B],
  ]);
  await actor(db, B);
  await rpc(db, "execute_p2p_escrow", [offer]);
  await db.exec("RESET ROLE");
  await db.query(
    "UPDATE race_private.sim_events SET starts_at=clock_timestamp(),funding_closes_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
    [event],
  );
  const context = await rpc(db, "sim_result_context", [T, offer]);
  await service(db);
  await rpc(db, "sim_commit_result", [
    T,
    P,
    offer,
    "cash:" + offer,
    session,
    "Spa",
    context.starts_at,
    "d".repeat(64),
    resolution,
    resolution === "winner" ? "60" : null,
    resolution === "winner" ? "62" : null,
    {},
  ]);
  return offer;
}
test("cash redemption ledger preserves provenance, isolates ownership and reconciles reversals", async (t) => {
  const { db, wallets, program } = await database();
  try {
    await eligible(db, A, program);
    await eligible(db, B, program);
    await service(db);
    await rpc(db, "credit_wallet", [
      T,
      wallets[A],
      "SC",
      "200",
      "cash-opening-a",
    ]);
    await rpc(db, "credit_wallet", [
      T,
      wallets[B],
      "SC",
      "200",
      "cash-opening-b",
    ]);
    await actor(db, A);
    assert.equal((await rpc(db, "cash_state", [T])).redeemable_sc, "0.000000");
    await t.test(
      "promotional SC cannot be redeemed; clients cannot self-verify or supply another owner",
      async () => {
        await assert.rejects(
          rpc(db, "execute_atomic_withdrawal_debit", [T, randomUUID(), "50"]),
          /kyc_required/,
        );
        await assert.rejects(
          rpc(db, "cash_record_kyc", [
            T,
            A,
            "fake",
            "a".repeat(24),
            "Verified",
            new Date().toISOString(),
            "b".repeat(64),
          ]),
          /permission denied/,
        );
        await assert.rejects(
          db.exec("UPDATE race_private.users SET kyc_status='Verified'"),
          /permission denied/,
        );
        await assert.rejects(rpc(db, "cash_state", [T2]), /profile_required/);
      },
    );
    await challenge(db, wallets, "SC", "50");
    await actor(db, A);
    assert.equal((await rpc(db, "cash_state", [T])).redeemable_sc, "90.000000");
    await t.test(
      "zero-fee race refunds restore SC classification without converting grants",
      async () => {
        const before = await rpc(db, "cash_state", [T]);
        await challenge(db, wallets, "SC", "20", "no_clean_laps");
        await actor(db, A);
        assert.equal(
          (await rpc(db, "cash_state", [T])).redeemable_sc,
          before.redeemable_sc,
        );
      },
    );
    const bank = await rpc(db, "cash_begin_account", [T]);
    await service(db);
    await rpc(db, "cash_record_kyc", [
      T,
      A,
      "real-test-vendor-receipt",
      "a".repeat(24),
      "Verified",
      new Date().toISOString(),
      "b".repeat(64),
    ]);
    await rpc(db, "cash_bind_account", [
      T,
      wallets[A],
      bank.intent_id,
      "acct_testOwner",
      "ba_testOwner",
      true,
    ]);
    await actor(db, A);
    const id = randomUUID();
    await t.test(
      "one atomic reservation, strict decimal limits and unchanged terms on retry",
      async () => {
        for (const amount of [
          "49.99",
          "10000.01",
          "50.000001",
          "NaN",
          "Infinity",
          "-50",
        ])
          await assert.rejects(
            rpc(db, "execute_atomic_withdrawal_debit", [
              T,
              randomUUID(),
              amount,
            ]),
            /invalid_amount|redemption_limits/,
          );
        const first = await rpc(db, "execute_atomic_withdrawal_debit", [
          T,
          id,
          "50",
        ]);
        assert.equal(first.state, "Reserved");
        assert.equal(
          (await rpc(db, "execute_atomic_withdrawal_debit", [T, id, "50.00"]))
            .duplicate,
          true,
        );
        assert.equal(
          (await rpc(db, "cash_state", [T])).redeemable_sc,
          "40.000000",
        );
        await assert.rejects(
          rpc(db, "execute_atomic_withdrawal_debit", [T, id, "60"]),
          /redemption_conflict/,
        );
        await assert.rejects(
          rpc(db, "execute_atomic_withdrawal_debit", [T, randomUUID(), "50"]),
          /insufficient_balance/,
        );
        await actor(db, B);
        await assert.rejects(
          rpc(db, "execute_atomic_withdrawal_debit", [T, id, "50"]),
          /redemption_conflict/,
        );
        await actor(db, A);
      },
    );
    await t.test(
      "provider-confirmed payout and late bank return post exactly one compensating credit",
      async () => {
        await service(db);
        const j = await rpc(db, "cash_lease", []);
        assert.equal(j.id, id);
        const record = (phase, obj) =>
          rpc(db, "cash_record", [
            T,
            id,
            j.lease_token,
            phase,
            obj,
            phase + ":" + id,
            "c".repeat(64),
          ]);
        await assert.rejects(
          record("paid", "po_testPayout"),
          /invalid_transition/,
        );
        await rpc(db, "cash_start_phase", [T, id, j.lease_token, "transfer"]);
        await record("transfer", "tr_testTransfer");
        await rpc(db, "cash_start_phase", [T, id, j.lease_token, "payout"]);
        await record("payout", "po_testPayout");
        await record("paid", "po_testPayout");
        assert.equal((await record("paid", "po_testPayout")).duplicate, true);
        await record("failed", "po_testPayout");
        await rpc(db, "cash_start_phase", [T, id, j.lease_token, "reversal"]);
        await record("returned", "tr_testTransfer");
        assert.equal(
          (await record("returned", "tr_testTransfer")).duplicate,
          true,
        );
        await actor(db, A);
        assert.equal(
          (await rpc(db, "cash_state", [T])).redeemable_sc,
          "90.000000",
        );
        assert.equal(
          (await rpc(db, "cash_state", [T])).requests[0].state,
          "Returned",
        );
        await service(db);
        const tax = await rpc(db, "cash_tax_export", [
          T,
          new Date().getUTCFullYear(),
        ]);
        assert.equal(tax[0].net_usd, "0.000000");
        const audit = await exportWalletAudit(client(db), T, wallets[A]);
        assert.ok(
          audit.records.some(
            (r) =>
              JSON.parse(r.canonical_payload).journal.kind === "pay_redemption",
          ),
        );
      },
    );
    await t.test(
      "audit write failure rolls the reservation and balance debit back together",
      async () => {
        await db.exec(
          "RESET ROLE;CREATE FUNCTION race_private.fail_cash_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'cash_audit_failure';END$$;CREATE TRIGGER fail_cash BEFORE INSERT ON race_private.audit_records FOR EACH ROW EXECUTE FUNCTION race_private.fail_cash_audit();",
        );
        await actor(db, A);
        const request = randomUUID();
        await assert.rejects(
          rpc(db, "execute_atomic_withdrawal_debit", [T, request, "50"]),
          /cash_audit_failure/,
        );
        await db.exec(
          "RESET ROLE;DROP TRIGGER fail_cash ON race_private.audit_records",
        );
        await actor(db, A);
        const state = await rpc(db, "cash_state", [T]);
        assert.equal(state.redeemable_sc, "90.000000");
        assert.ok(!state.requests.some((r) => r.id === request));
      },
    );
    await service(db);
    assert.equal((await rpc(db, "cash_lease", [])).empty, true);
    await t.test(
      "postal processing deduplicates physical evidence and grants non-redeemable SC",
      async () => {
        await service(db);
        const request = randomUUID(),
          args = [
            T,
            P,
            request,
            A,
            program,
            "d".repeat(64),
            new Date().toISOString(),
            "Validated physical receipt test evidence",
            "e".repeat(64),
          ];
        assert.equal(
          (await rpc(db, "cash_postal", args)).credited_sc,
          "5.000000",
        );
        assert.equal((await rpc(db, "cash_postal", args)).duplicate, true);
        await assert.rejects(
          rpc(db, "cash_postal", [
            T,
            P,
            randomUUID(),
            A,
            program,
            ...args.slice(5),
          ]),
          /duplicate key/,
        );
        await actor(db, A);
        assert.equal(
          (await rpc(db, "cash_state", [T])).redeemable_sc,
          "90.000000",
        );
      },
    );
  } finally {
    await db.close();
  }
});
