// Native PostgreSQL, independent connections. NEVER point this at production.
// Run against a new disposable database with RACING_ALLOW_TEST_DATABASE=1.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  seed,
  create,
  settle,
  settlementArgs,
  challenge,
  T,
  A,
  B,
} from "./fixtures.js";

async function waitForBackend(admin, pid, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      "SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (rows[0] && expected(rows[0])) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("database_backend_did_not_reach_expected_wait_state");
}

test("native PostgreSQL concurrent escrow mutations", async (t) => {
  if (
    !process.env.DATABASE_URL ||
    process.env.RACING_ALLOW_TEST_DATABASE !== "1"
  ) {
    throw new Error(
      "requires_DATABASE_URL_and_RACING_ALLOW_TEST_DATABASE_1_for_a_new_disposable_database",
    );
  }
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 12,
    connectionTimeoutMillis: 5000,
  });
  let admin;
  try {
    admin = await pool.connect();
    const existing = await admin.query(
      "SELECT 1 FROM pg_namespace WHERE nspname='race_private'",
    );
    assert.equal(
      existing.rowCount,
      0,
      "fresh disposable database required; refusing to modify an existing installation",
    );
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;`);
    await admin.query(
      await readFile(new URL("../sql/001_engine.sql", import.meta.url), "utf8"),
    );
    async function reset() {
      await admin.query(`TRUNCATE race_private.telemetry_events,race_private.journal_lines,
        race_private.journal_transactions,race_private.challenges,race_private.treasury,
        race_private.users,race_private.providers,race_private.tenants RESTART IDENTITY`);
      await seed(admin);
    }
    async function concurrent(tasks) {
      const acquired = await Promise.allSettled(
        tasks.map(() => pool.connect()),
      );
      const clients = acquired
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
      const failed = acquired.find((r) => r.status === "rejected");
      if (failed) {
        clients.forEach((c) => c.release());
        throw failed.reason;
      }
      try {
        await Promise.all(clients.map((c) => c.query("SET ROLE service_role")));
        return await Promise.allSettled(tasks.map((fn, i) => fn(clients[i])));
      } finally {
        const reset = await Promise.allSettled(
          clients.map((c) => c.query("RESET ROLE")),
        );
        clients.forEach((c, i) =>
          c.release(
            reset[i].status === "rejected" ? reset[i].reason : undefined,
          ),
        );
        const failedReset = reset.find((r) => r.status === "rejected");
        if (failedReset) throw failedReset.reason;
      }
    }
    async function assertConservation() {
      const { rows } = await admin.query(
        `SELECT
        (SELECT sum(gc_balance) FROM race_private.users WHERE tenant_id=$1)
        +coalesce((SELECT sum(remaining_escrow) FROM race_private.challenges WHERE tenant_id=$1 AND token_type='GC'),0)
        +coalesce((SELECT sum(balance) FROM race_private.treasury WHERE tenant_id=$1 AND token_type='GC'),0) AS total`,
        [T],
      );
      assert.equal(rows[0].total, "200.000000");
      assert.equal(
        (
          await admin.query(
            "SELECT sum(delta)::text AS total FROM race_private.journal_lines",
          )
        ).rows[0].total,
        "0.000000",
      );
    }
    await t.test(
      "same funding request on eight connections debits once",
      async () => {
        await reset();
        const c = challenge();
        const results = await concurrent(
          Array.from({ length: 8 }, () => (db) => create(db, c)),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 8);
        assert.equal(
          results.filter((r) => r.value?.duplicate === false).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM race_private.challenges",
            )
          ).rows[0].n,
          1,
        );
        await assertConservation();
      },
    );
    await t.test(
      "distinct simultaneous challenges cannot overspend a shared wallet",
      async () => {
        await reset();
        const c1 = challenge({ p_entry_fee: "80" }),
          c2 = challenge({ p_entry_fee: "80" });
        const results = await concurrent([
          (db) => create(db, c1),
          (db) => create(db, c2),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          results.filter(
            (r) => r.status === "rejected" && r.reason.code === "PT409",
          ).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT min(gc_balance)::text AS b FROM race_private.users WHERE tenant_id=$1",
              [T],
            )
          ).rows[0].b,
          "20.000000",
        );
        await assertConservation();
      },
    );
    await t.test(
      "opposite participant order acquires canonical wallet locks without deadlock",
      async () => {
        await reset();
        const c1 = challenge({ p_entry_fee: "40" }),
          c2 = challenge({
            p_entry_fee: "50",
            p_challenger_id: B,
            p_opponent_id: A,
          });
        const results = await concurrent([
          (db) => create(db, c1),
          (db) => create(db, c2),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
        await assertConservation();
      },
    );
    await t.test(
      "eight identical final events credit winner and treasury exactly once",
      async () => {
        await reset();
        const c = challenge();
        await create(admin, c);
        const args = settlementArgs(c);
        const results = await concurrent(
          Array.from({ length: 8 }, () => (db) => settle(db, args)),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 8);
        assert.equal(
          results.filter((r) => r.value?.duplicate === false).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT gc_balance::text AS b FROM race_private.users WHERE tenant_id=$1 AND id=$2",
              [T, A],
            )
          ).rows[0].b,
          "108.000000",
        );
        await assertConservation();
      },
    );
    await t.test(
      "contradictory final events serialize; only one terminal posting is permitted",
      async () => {
        await reset();
        const c = challenge();
        await create(admin, c);
        const x = settlementArgs(c),
          y = settlementArgs(c, {
            p_payload_sha256: "b".repeat(64),
            p_winner_id: B,
            p_challenger_best: "70",
            p_opponent_best: "60",
          });
        const results = await concurrent([
          (db) => settle(db, x),
          (db) => settle(db, y),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          results.filter(
            (r) => r.status === "rejected" && r.reason.code === "PT409",
          ).length,
          1,
        );
        await assertConservation();
      },
    );
    await t.test(
      "late telemetry versus timeout workers gives only a complete, fee-free refund",
      async () => {
        await reset();
        const c = challenge();
        await create(admin, c);
        await admin.query(
          "UPDATE race_private.challenges SET telemetry_deadline=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
          [T, c.p_request_id],
        );
        const args = settlementArgs(c);
        const results = await concurrent([
          (db) => settle(db, args),
          (db) =>
            db.query("SELECT public.refund_expired_challenge($1,$2)", [
              T,
              c.p_request_id,
            ]),
          (db) =>
            db.query("SELECT public.refund_expired_challenge($1,$2)", [
              T,
              c.p_request_id,
            ]),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
        assert.equal(
          results.filter(
            (r) => r.status === "rejected" && r.reason.code === "PT409",
          ).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT min(gc_balance)::text AS b FROM race_private.users WHERE tenant_id=$1",
              [T],
            )
          ).rows[0].b,
          "100.000000",
        );
        await assertConservation();
      },
    );
    for (const end of ["COMMIT", "ROLLBACK"]) {
      await t.test(
        `uncommitted settlement blocks its retry; ${end.toLowerCase()} chooses replay or fresh payout`,
        async () => {
          await reset();
          const c = challenge();
          await create(admin, c);
          const args = settlementArgs(c);
          const holder = await pool.connect(),
            waiter = await pool.connect();
          let pending;
          try {
            await holder.query("BEGIN");
            await holder.query("SET LOCAL ROLE service_role");
            await waiter.query("SET ROLE service_role");
            await settle(holder, args); // Returns while its surrounding transaction remains open.
            pending = settle(waiter, args).then(
              (result) => ({ result }),
              (error) => ({ error }),
            );
            await waitForBackend(
              admin,
              waiter.processID,
              (row) => row.wait_event_type === "Lock",
            );
            // A different connection cannot observe a credit/event before commit.
            assert.equal(
              (
                await admin.query(
                  "SELECT gc_balance::text AS b FROM race_private.users WHERE tenant_id=$1 AND id=$2",
                  [T, A],
                )
              ).rows[0].b,
              "90.000000",
            );
            assert.equal(
              (
                await admin.query(
                  "SELECT count(*)::int AS n FROM race_private.telemetry_events",
                )
              ).rows[0].n,
              0,
            );
            await holder.query(end);
            const finished = await pending;
            if (finished.error) throw finished.error;
            assert.equal(finished.result.duplicate, end === "COMMIT");
            assert.equal(
              (
                await admin.query(
                  "SELECT count(*)::int AS n FROM race_private.journal_transactions WHERE kind='settle'",
                )
              ).rows[0].n,
              1,
            );
            await assertConservation();
          } finally {
            await holder.query("ROLLBACK").catch(() => {});
            if (pending) await pending;
            await waiter.query("RESET ROLE").catch(() => {});
            holder.release();
            waiter.release();
          }
        },
      );
    }
    await t.test(
      "cancelling a backend during final-event persistence rolls back every credit and preserves escrow",
      async () => {
        await reset();
        const c = challenge();
        await create(admin, c);
        const args = settlementArgs(c);
        await admin.query(`CREATE FUNCTION race_private.pause_event_posting() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(10); RETURN NEW; END; $$;
        CREATE TRIGGER pause_event BEFORE INSERT ON race_private.telemetry_events
        FOR EACH ROW EXECUTE FUNCTION race_private.pause_event_posting();`);
        const writer = await pool.connect();
        let pending;
        try {
          await writer.query("SET ROLE service_role");
          pending = settle(writer, args).then(
            (result) => ({ result }),
            (error) => ({ error }),
          );
          await waitForBackend(
            admin,
            writer.processID,
            (row) => row.wait_event === "PgSleep",
          );
          assert.equal(
            (
              await admin.query("SELECT pg_cancel_backend($1) AS cancelled", [
                writer.processID,
              ])
            ).rows[0].cancelled,
            true,
          );
          const cancelled = await pending;
          assert.equal(cancelled.error?.code, "57014");
          assert.equal(
            (
              await admin.query(
                "SELECT gc_balance::text AS b FROM race_private.users WHERE tenant_id=$1 AND id=$2",
                [T, A],
              )
            ).rows[0].b,
            "90.000000",
          );
          assert.equal(
            (
              await admin.query(
                "SELECT remaining_escrow::text AS e FROM race_private.challenges",
              )
            ).rows[0].e,
            "20.000000",
          );
          assert.equal(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM race_private.treasury",
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM race_private.telemetry_events",
              )
            ).rows[0].n,
            0,
          );
          await admin.query(
            "DROP TRIGGER pause_event ON race_private.telemetry_events",
          );
          assert.equal((await settle(writer, args)).duplicate, false);
          await assertConservation();
        } finally {
          if (pending) {
            await admin
              .query("SELECT pg_cancel_backend($1)", [writer.processID])
              .catch(() => {});
            await pending;
          }
          await writer.query("RESET ROLE").catch(() => {});
          writer.release();
          await admin.query(
            "DROP TRIGGER IF EXISTS pause_event ON race_private.telemetry_events",
          );
          await admin.query("DROP FUNCTION race_private.pause_event_posting()");
        }
      },
    );
    await t.test(
      "SERIALIZABLE funding conflict rolls back the whole losing transaction",
      async () => {
        await reset();
        const c1 = challenge({ p_entry_fee: "80" }),
          c2 = challenge({ p_entry_fee: "80" });
        async function serializable(db, c) {
          await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          try {
            const result = await create(db, c);
            await db.query("COMMIT");
            return result;
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          }
        }
        const results = await concurrent([
          (db) => serializable(db, c1),
          (db) => serializable(db, c2),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          results.filter(
            (r) =>
              r.status === "rejected" &&
              ["40001", "PT409"].includes(r.reason.code),
          ).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM race_private.challenges",
            )
          ).rows[0].n,
          1,
        );
        await assertConservation();
      },
    );
    await t.test(
      "simultaneous GC and SC funding preserves two isolated currency balances",
      async () => {
        await reset();
        const gc = challenge({ p_entry_fee: "70" }),
          sc = challenge({ p_entry_fee: "70", p_token_type: "SC" });
        const results = await concurrent([
          (db) => create(db, gc),
          (db) => create(db, sc),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
        const { rows } = await admin.query(
          "SELECT gc_balance::text AS gc,sc_balance::text AS sc FROM race_private.users WHERE tenant_id=$1 ORDER BY id",
          [T],
        );
        assert.deepEqual(rows, [
          { gc: "30.000000", sc: "30.000000" },
          { gc: "30.000000", sc: "30.000000" },
        ]);
        const scTotal = await admin.query(
          `SELECT
        (SELECT sum(sc_balance) FROM race_private.users WHERE tenant_id=$1)
        +(SELECT sum(remaining_escrow) FROM race_private.challenges WHERE tenant_id=$1 AND token_type='SC') AS total`,
          [T],
        );
        assert.equal(scTotal.rows[0].total, "200.000000");
        await assertConservation();
      },
    );
    await t.test(
      "authenticated offer acceptance serializes eight retries and rival acceptors without double funding",
      async () => {
        await reset();
        await admin.query(`CREATE SCHEMA auth;
        CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,is_anonymous boolean DEFAULT false);
        CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id));
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;`);
        await admin.query(
          await readFile(
            new URL(
              "../supabase/migrations/20261005224115_customer_app.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        await admin.query(
          "UPDATE race_private.tenants SET customer_signup_enabled=true WHERE id=$1",
          [T],
        );
        const provider = (
          await admin.query(
            "SELECT id FROM race_private.providers WHERE tenant_id=$1",
            [T],
          )
        ).rows[0].id;
        await admin.query(
          "INSERT INTO race_private.tracks(tenant_id,id,title,provider_id,enabled) VALUES($1,'coastal','Coastal Sprint',$2,true)",
          [T, provider],
        );
        const actors = [randomUUID(), randomUUID(), randomUUID()];
        for (const id of actors) {
          await admin.query(
            "INSERT INTO auth.users(id,email_confirmed_at) VALUES($1,now())",
            [id],
          );
          await admin.query("INSERT INTO auth.sessions VALUES($1,$1)", [id]);
        }
        async function asActor(id, run) {
          const c = await pool.connect();
          try {
            await c.query("SELECT set_config('request.jwt.claims',$1,false)", [
              JSON.stringify({ sub: id, session_id: id }),
            ]);
            await c.query("SET ROLE authenticated");
            return await run(c);
          } finally {
            await c.query("RESET ROLE");
            await c.query("SELECT set_config('request.jwt.claims','',false)");
            c.release();
          }
        }
        const wallets = [];
        for (let i = 0; i < actors.length; i++)
          wallets.push(
            (
              await asActor(actors[i], (c) =>
                c.query("SELECT public.race_enroll($1,$2,true) AS r", [
                  T,
                  "Native_" + i,
                ]),
              )
            ).rows[0].r.user_id,
          );
        const first = randomUUID();
        await asActor(actors[0], (c) =>
          c.query("SELECT public.race_offer($1,$2,'coastal','GC','10.00')", [
            T,
            first,
          ]),
        );
        const replies = await Promise.allSettled(
          Array.from({ length: 8 }, () =>
            asActor(actors[1], (c) =>
              c.query("SELECT public.race_accept($1,$2,true) AS r", [T, first]),
            ),
          ),
        );
        assert.equal(replies.filter((r) => r.status === "fulfilled").length, 8);
        assert.equal(
          replies.filter((r) => r.value?.rows[0].r.duplicate === false).length,
          1,
        );
        const rival = randomUUID();
        await asActor(actors[0], (c) =>
          c.query("SELECT public.race_offer($1,$2,'coastal','GC','10.00')", [
            T,
            rival,
          ]),
        );
        const competitors = await Promise.allSettled(
          [1, 2].map((i) =>
            asActor(actors[i], (c) =>
              c.query("SELECT public.race_accept($1,$2,true)", [T, rival]),
            ),
          ),
        );
        assert.equal(
          competitors.filter((r) => r.status === "fulfilled").length,
          1,
        );
        assert.equal(
          competitors.filter(
            (r) => r.status === "rejected" && r.reason.code === "PT409",
          ).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM race_private.challenges WHERE id=ANY($1::uuid[])",
              [[first, rival]],
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT sum(gc_balance)::text AS n FROM race_private.users WHERE id=ANY($1::uuid[])",
              [wallets],
            )
          ).rows[0].n,
          "2960.000000",
        );
        assert.equal(
          (
            await admin.query(
              "SELECT sum(remaining_escrow)::text AS n FROM race_private.challenges WHERE id=ANY($1::uuid[])",
              [[first, rival]],
            )
          ).rows[0].n,
          "40.000000",
        );
        assert.equal(
          (
            await admin.query(
              "SELECT sum(delta)::text AS n FROM race_private.journal_lines",
            )
          ).rows[0].n,
          "0.000000",
        );
        await admin.query("DELETE FROM auth.sessions WHERE id=$1", [actors[1]]);
        await assert.rejects(
          asActor(actors[1], (c) =>
            c.query("SELECT public.race_state($1)", [T]),
          ),
          /active_session_required/,
        );
      },
    );
    await t.test(
      "external simulator acceptance and purchase fulfillment serialize independent worker retries",
      async () => {
        await admin.query(
          await readFile(
            new URL(
              "../supabase/migrations/20261006073056_sim_racing_commerce.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const ids = [randomUUID(), randomUUID(), randomUUID()],
          authIds = [randomUUID(), randomUUID(), randomUUID()],
          event = randomUUID();
        const provider = (
          await admin.query(
            "SELECT id FROM race_private.providers WHERE tenant_id=$1",
            [T],
          )
        ).rows[0].id;
        await admin.query(
          "UPDATE race_private.tenants SET commerce_enabled=true WHERE id=$1",
          [T],
        );
        for (let i = 0; i < ids.length; i++) {
          await admin.query(
            "INSERT INTO race_private.users(tenant_id,id,auth_user_id) VALUES($1,$2,$3)",
            [T, ids[i], authIds[i]],
          );
          await admin.query(
            "INSERT INTO race_private.profiles(tenant_id,user_id,handle,sc_eligible) VALUES($1,$2,$3,true)",
            [T, ids[i], "External_" + i],
          );
          await admin.query("SELECT public.credit_wallet($1,$2,'GC',100,$3)", [
            T,
            ids[i],
            "external-seed:" + i,
          ]);
          await admin.query(
            "SELECT public.sim_link_identity($1,$2,'iracing',$3)",
            [T, authIds[i], String(100 + i)],
          );
          await admin.query(
            "SELECT public.sim_link_identity($1,$2,'discord',$3)",
            [T, authIds[i], String(100000000000000000n + BigInt(i))],
          );
        }
        await admin.query(
          "INSERT INTO race_private.sim_events(tenant_id,id,provider_id,game,external_session_id,title,track_name,starts_at,funding_closes_at,deadline,rule,entrants) VALUES($1,$2,$3,'iracing','native-session','Native sim race','Spa',now()+interval '30 minutes',now()+interval '20 minutes',now()+interval '2 hours','fastest_clean_lap','[\"100\",\"101\",\"102\"]')",
          [T, event, provider],
        );
        const offer = randomUUID();
        await admin.query(
          "SELECT public.sim_discord_offer($1,'100000000000000000','100000000000000001',$2,$3,'GC','10.00')",
          [T, offer, event],
        );
        const accepted = await concurrent(
          Array.from(
            { length: 8 },
            () => (c) =>
              c.query(
                "SELECT public.sim_discord_accept($1,'100000000000000001',$2) AS r",
                [T, offer],
              ),
          ),
        );
        assert.equal(
          accepted.filter((r) => r.status === "fulfilled").length,
          8,
        );
        assert.equal(
          accepted.filter((r) => r.value?.rows[0].r.duplicate === false).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT sum(gc_balance)::text AS n FROM race_private.users WHERE id=ANY($1::uuid[])",
              [ids],
            )
          ).rows[0].n,
          "280.000000",
        );
        assert.equal(
          (
            await admin.query(
              "SELECT remaining_escrow::text AS n FROM race_private.challenges WHERE id=$1",
              [offer],
            )
          ).rows[0].n,
          "20.000000",
        );
        const order = randomUUID();
        await admin.query(
          "INSERT INTO race_private.commerce_catalog VALUES($1,'native_pack',1000,10000,10,true)",
          [T],
        );
        await admin.query(
          "INSERT INTO race_private.commerce_orders(tenant_id,id,user_id,package_id,amount_cents,gc,sc) VALUES($1,$2,$3,'native_pack',1000,10000,10)",
          [T, order, ids[0]],
        );
        const fulfilled = await concurrent(
          Array.from(
            { length: 8 },
            () => (c) =>
              c.query(
                "SELECT public.fulfill_coin_purchase($1,$2,'cs_test_native','pi_native','evt_native',1000,'usd') AS r",
                [T, order],
              ),
          ),
        );
        assert.equal(
          fulfilled.filter((r) => r.status === "fulfilled").length,
          8,
        );
        assert.equal(
          fulfilled.filter((r) => r.value?.rows[0].r.duplicate === false)
            .length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT gc_balance::text AS gc,sc_balance::text AS sc FROM race_private.users WHERE id=$1",
              [ids[0]],
            )
          ).rows[0].gc,
          "10090.000000",
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM race_private.payment_ledgers",
            )
          ).rows[0].n,
          1,
        );
        // Fail after wallet posting, before evidence receipt. The entire RPC rolls back.
        await admin.query(
          "UPDATE race_private.sim_events SET starts_at=clock_timestamp(),funding_closes_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
          [event],
        );
        const context = (
          await admin.query("SELECT public.sim_result_context($1,$2) AS r", [
            T,
            offer,
          ])
        ).rows[0].r;
        await admin.query(
          "CREATE FUNCTION race_private.reject_evidence_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'evidence_disk_failure';END$$; CREATE TRIGGER reject_evidence_test BEFORE INSERT ON race_private.provider_evidence FOR EACH ROW EXECUTE FUNCTION race_private.reject_evidence_test();",
        );
        const values = [
          T,
          provider,
          offer,
          "native:" + offer,
          "native-session",
          "Spa",
          context.starts_at,
          "a".repeat(64),
          "winner",
          "60",
          "62",
          {},
        ];
        const statement =
          "SELECT public.sim_commit_result(" +
          values.map((_, i) => "$" + (i + 1)).join(",") +
          ")";
        await assert.rejects(
          admin.query(statement, values),
          /evidence_disk_failure/,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT remaining_escrow::text AS n FROM race_private.challenges WHERE id=$1",
              [offer],
            )
          ).rows[0].n,
          "20.000000",
        );
        await admin.query(
          "DROP TRIGGER reject_evidence_test ON race_private.provider_evidence",
        );
        await admin.query(statement, values);
        assert.equal(
          (
            await admin.query(
              "SELECT sum(delta)::text AS n FROM race_private.journal_lines",
            )
          ).rows[0].n,
          "0.000000",
        );
      },
    );
    await t.test(
      "institutional free-entry retries, sybil review and audit rollback serialize real PostgreSQL connections",
      async () => {
        await admin.query(
          await readFile(
            new URL(
              "../supabase/migrations/20261006092644_institutional_controls.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const provider = (
          await admin.query(
            "SELECT id FROM race_private.providers WHERE tenant_id=$1",
            [T],
          )
        ).rows[0].id;
        const actors = [randomUUID(), randomUUID(), randomUUID()],
          wallets = [],
          program = randomUUID();
        const asActor = async (c, id) => {
          await c.query("SELECT set_config('request.jwt.claims',$1,false)", [
            JSON.stringify({ sub: id, session_id: id }),
          ]);
          await c.query("SET ROLE authenticated");
        };
        const rpc = async (c, name, args) =>
          (
            await c.query(
              "SELECT public." +
                name +
                "(" +
                args.map((_, i) => "$" + (i + 1)).join(",") +
                ") AS r",
              args.map((value) =>
                Array.isArray(value) ? JSON.stringify(value) : value,
              ),
            )
          ).rows[0].r;
        await admin.query(
          "UPDATE race_private.tenants SET customer_signup_enabled=true,sc_enabled=true WHERE id=$1",
          [T],
        );
        for (const [i, id] of actors.entries()) {
          await admin.query(
            "INSERT INTO auth.users(id,email_confirmed_at) VALUES($1,now())",
            [id],
          );
          await admin.query("INSERT INTO auth.sessions VALUES($1,$1)", [id]);
          await asActor(admin, id);
          wallets.push(
            (await rpc(admin, "race_enroll", [T, "Institutional_" + i, true]))
              .user_id,
          );
          await admin.query("RESET ROLE;RESET request.jwt.claims");
        }
        await rpc(admin, "grid_publish_program", [
          T,
          provider,
          randomUUID(),
          program,
          "native-v4",
          "Native-only rules",
          "Test-only sponsor",
          "https://rules.example.test/native",
          "a".repeat(64),
          new Date(Date.now() - 3600000).toISOString(),
          new Date(Date.now() + 86400000).toISOString(),
          21,
          ["US-CA"],
          "1.000000",
          24,
          1,
          "Test-only authorization",
          "b".repeat(64),
        ]);
        await rpc(admin, "grid_activate_program", [
          T,
          provider,
          randomUUID(),
          program,
          true,
          "Test-only activation",
          "c".repeat(64),
        ]);
        const receipt = async (c, id, purpose, subject) =>
          rpc(c, "grid_record_compliance", [
            T,
            provider,
            randomUUID(),
            id,
            purpose,
            "approved",
            "test_verified",
            new Date(Date.now() - 1000).toISOString(),
            new Date(Date.now() + 120000).toISOString(),
            subject ?? null,
            purpose === "identity" ? 21 : null,
            purpose === "location" ? "US-CA" : null,
            false,
            "d".repeat(64),
          ]);
        await receipt(admin, actors[0], "identity", "e".repeat(64));
        await receipt(admin, actors[0], "location");
        await asActor(admin, actors[0]);
        await rpc(admin, "grid_consent", [T, program]);
        await admin.query("RESET ROLE;RESET request.jwt.claims");
        const request = randomUUID();
        const claims = await concurrent(
          Array.from({ length: 8 }, () => async (c) => {
            await asActor(c, actors[0]);
            try {
              return await rpc(c, "grid_ame", [T, request, program]);
            } finally {
              await c.query("RESET ROLE;RESET request.jwt.claims");
            }
          }),
        );
        assert.equal(claims.filter((r) => r.status === "fulfilled").length, 8);
        assert.equal(
          claims.filter((r) => r.value.duplicate === false).length,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT sc_balance::text AS n FROM race_private.users WHERE id=$1",
              [wallets[0]],
            )
          ).rows[0].n,
          "1.000000",
        );
        const quota = await concurrent(
          Array.from({ length: 8 }, () => async (c) => {
            await asActor(c, actors[0]);
            try {
              return await rpc(c, "grid_ame", [T, randomUUID(), program]);
            } finally {
              await c.query("RESET ROLE;RESET request.jwt.claims");
            }
          }),
        );
        assert.ok(
          quota.every(
            (r) =>
              r.status === "fulfilled" &&
              r.value.reason === "period_limit_reached",
          ),
        );
        const identity = await concurrent(
          [1, 2].map(
            (i) => (c) => receipt(c, actors[i], "identity", "f".repeat(64)),
          ),
        );
        assert.equal(
          identity.filter(
            (r) => r.status === "fulfilled" && r.value.decision === "approved",
          ).length,
          1,
        );
        assert.equal(
          identity.filter(
            (r) => r.status === "fulfilled" && r.value.decision === "review",
          ).length,
          1,
        );
        const before = (
          await admin.query(
            "SELECT gc_balance::text AS n FROM race_private.users WHERE id=$1",
            [wallets[0]],
          )
        ).rows[0].n;
        await admin.query(
          "CREATE FUNCTION race_private.audit_failure_native() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit_storage_failure_native';END$$;CREATE TRIGGER fail_audit_native BEFORE INSERT ON race_private.audit_records FOR EACH ROW EXECUTE FUNCTION race_private.audit_failure_native();",
        );
        await assert.rejects(
          rpc(admin, "credit_wallet", [
            T,
            wallets[0],
            "GC",
            "10",
            "native-audit-failure",
          ]),
          /audit_storage_failure_native/,
        );
        await admin.query(
          "DROP TRIGGER fail_audit_native ON race_private.audit_records",
        );
        assert.equal(
          (
            await admin.query(
              "SELECT gc_balance::text AS n FROM race_private.users WHERE id=$1",
              [wallets[0]],
            )
          ).rows[0].n,
          before,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM race_private.journal_transactions WHERE external_ref='native-audit-failure'",
            )
          ).rows[0].n,
          0,
        );
        const balance = await admin.query(
          "SELECT sum(delta)::text AS n FROM race_private.journal_lines",
        );
        assert.equal(balance.rows[0].n, "0.000000");
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM race_private.journal_transactions j LEFT JOIN race_private.journal_seals s ON(s.tenant_id,s.transaction_id)=(j.tenant_id,j.id) WHERE s.transaction_id IS NULL",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "cash withdrawals across independent sessions cannot overspend or double-reserve",
      async () => {
        await admin.query("RESET ROLE");
        await admin.query(
          await readFile(
            new URL(
              "../supabase/migrations/20261006112856_cash_redemption.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const actorId = randomUUID();
        await admin.query(
          "INSERT INTO auth.users(id,email_confirmed_at) VALUES($1,now());",
          [actorId],
        );
        await admin.query(
          "INSERT INTO auth.sessions(id,user_id) VALUES($1,$1)",
          [actorId],
        );
        const claims = JSON.stringify({ sub: actorId, session_id: actorId });
        await admin.query("SELECT set_config('request.jwt.claims',$1,false)", [
          claims,
        ]);
        await admin.query("SET ROLE authenticated");
        const own = (
          await admin.query(
            "SELECT public.race_enroll($1,'NativeCashOwner',true) AS r",
            [T],
          )
        ).rows[0].r.user_id;
        const program = (
          await admin.query("SELECT public.grid_program($1) AS r", [T])
        ).rows[0].r.program.id;
        await admin.query("SELECT public.grid_consent($1,$2)", [T, program]);
        const account = (
          await admin.query("SELECT public.cash_begin_account($1) AS r", [T])
        ).rows[0].r;
        await admin.query("RESET ROLE");
        const provider = (
          await admin.query(
            "SELECT id FROM race_private.providers WHERE tenant_id=$1 AND enabled LIMIT 1",
            [T],
          )
        ).rows[0].id;
        // Native fixtures seed classified winnings; full source-based classification
        // and refund restoration are verified separately against the complete schema.
        await admin.query(
          "UPDATE race_private.users SET sc_balance=100,sc_redeemable_balance=100 WHERE tenant_id=$1 AND id=$2",
          [T, own],
        );
        for (const purpose of ["identity", "location"])
          await admin.query(
            "SELECT public.grid_record_compliance($1,$2,$3,$4,$5,'approved','native cash evidence',clock_timestamp()-interval '1 second',clock_timestamp()+interval '2 minutes',$6,$7,$8,false,$9)",
            [
              T,
              provider,
              randomUUID(),
              actorId,
              purpose,
              purpose === "identity" ? "f".repeat(64) : null,
              purpose === "identity" ? 21 : null,
              purpose === "location" ? "US-CA" : null,
              "b".repeat(64),
            ],
          );
        await admin.query(
          "SELECT public.cash_record_kyc($1,$2,'native-cash-kyc',$3,'Verified',clock_timestamp(),$4)",
          [T, actorId, "f".repeat(24), "c".repeat(64)],
        );
        await admin.query(
          "SELECT public.cash_bind_account($1,$2,$3,'acct_nativeCash','ba_nativeCash',true)",
          [T, own, account.intent_id],
        );
        const requests = Array.from({ length: 8 }, () => randomUUID());
        const results = await concurrent(
          requests.map((id) => async (c) => {
            await c.query("SELECT set_config('request.jwt.claims',$1,false)", [
              claims,
            ]);
            await c.query("SET ROLE authenticated");
            return (
              await c.query(
                "SELECT public.execute_atomic_withdrawal_debit($1,$2,'50.00') AS r",
                [T, id],
              )
            ).rows[0].r;
          }),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
        for (const failure of results.filter((r) => r.status === "rejected"))
          assert.equal(failure.reason.code, "PT409");
        const balance = (
          await admin.query(
            "SELECT sc_balance::text,sc_redeemable_balance::text FROM race_private.users WHERE tenant_id=$1 AND id=$2",
            [T, own],
          )
        ).rows[0];
        assert.equal(balance.sc_balance, "0.000000");
        assert.equal(balance.sc_redeemable_balance, "0.000000");
        const winner = results.find((r) => r.status === "fulfilled").value.id;
        const replay = await concurrent(
          Array.from({ length: 8 }, () => async (c) => {
            await c.query("SELECT set_config('request.jwt.claims',$1,false)", [
              claims,
            ]);
            await c.query("SET ROLE authenticated");
            return (
              await c.query(
                "SELECT public.execute_atomic_withdrawal_debit($1,$2,'50.00') AS r",
                [T, winner],
              )
            ).rows[0].r;
          }),
        );
        assert.ok(
          replay.every(
            (r) => r.status === "fulfilled" && r.value.duplicate === true,
          ),
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM race_private.redemptions WHERE tenant_id=$1 AND user_id=$2",
              [T, own],
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT sum(delta)::text AS n FROM race_private.journal_lines",
            )
          ).rows[0].n,
          "0.000000",
        );
      },
    );
  } finally {
    admin?.release();
    await pool.end();
  }
});
