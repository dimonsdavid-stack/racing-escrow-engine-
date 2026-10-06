import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  reconcileRedemption,
  redemptionReady,
  connectBank,
} from "../src/redemption.js";
import { SumsubClient, createKycRouter } from "../src/kyc.js";
import { commerceReady } from "../src/commerce.js";
import { createApp } from "../src/app.js";
import express from "express";
import { T, A } from "./fixtures.js";
const env = {
  NODE_ENV: "production",
  STRIPE_SECRET_KEY: "sk_live_transport_fixture",
  COMMERCE_APPROVED: "true",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  APP_ORIGIN: "https://gridstake.example.test",
  SUMSUB_APP_TOKEN: "test-only-app-token",
  SUMSUB_SECRET_KEY: "test-only-signing-secret",
  SUMSUB_WEBHOOK_SECRET: "test-only-webhook-secret",
  SUMSUB_LEVEL_NAME: "verified-individual",
  SUMSUB_WEBSDK_HOST: "in.sumsub.com",
  RACING_TENANT_ID: T,
};
function fixture(state = "Reserved") {
  const j = {
    tenant_id: T,
    id: "11111111-1111-4111-8111-111111111111",
    user_id: A,
    lease_token: "22222222-2222-4222-8222-222222222222",
    amount_cents: 5000,
    amount_sc: "50.000000",
    account_id: "acct_bound",
    bank_id: "ba_bound",
    state,
    transfer_id: state === "Reserved" ? null : "tr_bound",
    payout_id: ["PayoutPending", "Paid", "Reversing"].includes(state)
      ? "po_bound"
      : null,
    transfer_started_at: null,
    payout_started_at: null,
    reversal_started_at: null,
  };
  const calls = [];
  const admin = {
    rpc(name, args) {
      return {
        abortSignal: async () => {
          calls.push({ name, args });
          if (name === "cash_start_phase")
            return {
              data: {
                ...j,
                [args.p_phase + "_started_at"]:
                  j[args.p_phase + "_started_at"] ?? new Date().toISOString(),
              },
              error: null,
              status: 200,
            };
          return { data: { recorded: true }, error: null, status: 200 };
        },
      };
    },
  };
  const metadata = { tenant_id: T, redemption_id: j.id, user_id: A };
  let transfer = {
    id: "tr_bound",
    amount: 5000,
    currency: "usd",
    destination: j.account_id,
    amount_reversed: 0,
    reversed: false,
    metadata,
  };
  let payout = {
    id: "po_bound",
    amount: 5000,
    currency: "usd",
    destination: j.bank_id,
    status: "pending",
    metadata,
  };
  const created = [];
  const stripe = {
    accounts: {
      retrieve: async () => ({
        id: j.account_id,
        metadata: { tenant_id: T, user_id: A },
        payouts_enabled: true,
        capabilities: { transfers: "active" },
        settings: { payouts: { schedule: { interval: "manual" } } },
      }),
    },
    transfers: {
      create: async (p, o) => {
        created.push({ kind: "transfer", p, o });
        return transfer;
      },
      retrieve: async () => transfer,
      list: async () => ({ data: [transfer], has_more: false }),
      createReversal: async (id, p, o) => {
        created.push({ kind: "reversal", p, o });
        transfer = { ...transfer, amount_reversed: 5000, reversed: true };
        return { id: "trr_bound" };
      },
    },
    payouts: {
      create: async (p, o) => {
        created.push({ kind: "payout", p, o });
        return payout;
      },
      retrieve: async () => payout,
      list: async () => ({ data: [payout], has_more: false }),
    },
  };
  return {
    j,
    admin,
    calls,
    stripe,
    created,
    setPayout: (p) => {
      payout = { ...payout, ...p };
    },
    setTransfer: (t) => {
      transfer = { ...transfer, ...t };
    },
  };
}
test("production refuses test-mode commerce or payout keys", () => {
  assert.ok(redemptionReady(env));
  assert.ok(commerceReady(env));
  assert.equal(
    redemptionReady({ ...env, STRIPE_SECRET_KEY: "sk_test_fixture" }),
    false,
  );
  assert.equal(
    commerceReady({ ...env, STRIPE_SECRET_KEY: "sk_test_fixture" }),
    false,
  );
});
test("creating a pending provider payout never records Paid or releases SC", async () => {
  const f = fixture();
  await reconcileRedemption(f.admin, f.stripe, f.j);
  assert.deepEqual(
    f.calls.filter((c) => c.name === "cash_record").map((c) => c.args.p_phase),
    ["transfer", "payout"],
  );
  assert.equal(f.created[1].o.stripeAccount, "acct_bound");
  assert.equal(f.created[1].p.destination, "ba_bound");
  assert.equal(f.created[0].o.idempotencyKey, `transfer:${T}:${f.j.id}`);
});
test("unknown commits recover existing objects after the provider idempotency window without new payouts", async () => {
  const f = fixture();
  f.j.transfer_started_at = new Date(Date.now() - 48 * 3600000).toISOString();
  f.j.payout_started_at = f.j.transfer_started_at;
  await reconcileRedemption(f.admin, f.stripe, f.j);
  assert.equal(f.created.length, 0);
  assert.deepEqual(
    f.calls.filter((c) => c.name === "cash_record").map((c) => c.args.p_phase),
    ["transfer", "payout"],
  );
});
test("an unresolved old transfer remains held for review", async () => {
  const f = fixture();
  f.j.transfer_started_at = new Date(Date.now() - 48 * 3600000).toISOString();
  f.stripe.transfers.list = async () => ({ data: [], has_more: false });
  await reconcileRedemption(f.admin, f.stripe, f.j);
  assert.equal(f.created.length, 0);
  assert.equal(
    f.calls.find((c) => c.name === "cash_record").args.p_phase,
    "review",
  );
});
test("a bank failure credits SC only after full provider reversal proof", async () => {
  const f = fixture("Paid");
  f.setPayout({ status: "failed" });
  await reconcileRedemption(f.admin, f.stripe, f.j);
  assert.deepEqual(
    f.calls.filter((c) => c.name === "cash_record").map((c) => c.args.p_phase),
    ["failed", "returned"],
  );
  assert.equal(f.created[0].kind, "reversal");
  const g = fixture("Reversing");
  g.setPayout({ status: "failed" });
  g.stripe.transfers.createReversal = async () => {
    throw new Error("network_interruption");
  };
  await assert.rejects(
    reconcileRedemption(g.admin, g.stripe, g.j),
    /network_interruption/,
  );
  assert.ok(!g.calls.some((c) => c.args.p_phase === "returned"));
});
test("a forged recipient, amount or metadata cannot become a confirmed payment", async () => {
  for (const patch of [
    { destination: "ba_attacker" },
    { amount: 9999 },
    { metadata: { tenant_id: T, redemption_id: "other", user_id: A } },
  ]) {
    const f = fixture("PayoutPending");
    f.setPayout({ ...patch, status: "paid" });
    await assert.rejects(
      reconcileRedemption(f.admin, f.stripe, f.j),
      /payout_binding_failed/,
    );
    assert.equal(f.calls.length, 0);
  }
});
test("provider authentication signs the exact method, path and raw JSON body", async () => {
  const requests = [];
  const client = new SumsubClient(env, async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      json: async () => ({ url: "https://in.sumsub.com/websdk/p/verified" }),
    };
  });
  const result = await client.link(`${T}:${A}`);
  assert.equal(new URL(result.url).hostname, "in.sumsub.com");
  const { url, init } = requests[0];
  assert.equal(
    new URL(url).pathname,
    "/resources/sdkIntegrations/levels/-/websdkLink",
  );
  const expected = createHmac("sha256", env.SUMSUB_SECRET_KEY)
    .update(
      init.headers["X-App-Access-Ts"] +
        "POST" +
        new URL(url).pathname +
        init.body,
    )
    .digest("hex");
  assert.equal(init.headers["X-App-Access-Sig"], expected);
  assert.equal(JSON.parse(init.body).userId, `${T}:${A}`);
});
test("KYC ingress rejects sandbox and forged signatures and retrieves current provider decision", async () => {
  const calls = [];
  const admin = {
    rpc(name, args) {
      return {
        abortSignal: async () => {
          calls.push({ name, args });
          return { data: { recorded: true }, error: null, status: 200 };
        },
      };
    },
  };
  const app = express();
  app.use(
    createKycRouter({
      admin,
      env,
      provider: {
        inspect: async () => ({
          status: "Unverified",
          observed: new Date().toISOString(),
          sha: "a".repeat(64),
        }),
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/kyc/webhook`;
    const send = async (event, valid = true) => {
      const body = JSON.stringify(event);
      return fetch(url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Payload-Digest-Alg": "HMAC_SHA256_HEX",
          "X-Payload-Digest": valid
            ? createHmac("sha256", env.SUMSUB_WEBHOOK_SECRET)
                .update(body)
                .digest("hex")
            : "f".repeat(64),
        },
      });
    };
    const e = {
      externalUserId: `${T}:${A}`,
      applicantId: "a".repeat(24),
      reviewResult: { reviewAnswer: "GREEN" },
    };
    assert.equal((await send(e, false)).status, 400);
    assert.equal((await send({ ...e, sandboxMode: true })).status, 400);
    assert.equal((await send(e)).status, 200);
    assert.equal(calls[0].args.p_status, "Unverified");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("cash endpoint rejects body-supplied owners and raw bank credentials", async () => {
  const app = createApp({
    env: {
      ...env,
      SUPABASE_URL: "https://fixture.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    },
    client: {},
    customerOptions: {
      makeClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: { id: A, email_confirmed_at: new Date().toISOString() },
            },
            error: null,
          }),
        },
      }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/wallet/redeem`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + "a".repeat(30),
        },
        body: JSON.stringify({
          user_id: A,
          amount_sc: "50",
          bank_routing: "123456789",
          bank_account: "123456",
        }),
      },
    );
    assert.equal(response.status, 422);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("withdrawal bank readiness requires verified ownership and legal-name agreement with current KYC", async () => {
  const context = {
    user_id: A,
    intent_id: "33333333-3333-4333-8333-333333333333",
    started_at: new Date().toISOString(),
    account_id: "acct_bound",
  };
  const bindings = [];
  const customer = {
    rpc() {
      return {
        abortSignal: async () => ({ data: context, error: null, status: 200 }),
      };
    },
  };
  const admin = {
    rpc(name, args) {
      bindings.push(args);
      return {
        abortSignal: async () => ({
          data: { bound: true },
          error: null,
          status: 200,
        }),
      };
    },
  };
  const account = {
    id: "acct_bound",
    type: "express",
    business_type: "individual",
    country: "US",
    metadata: { tenant_id: T, user_id: A, intent_id: context.intent_id },
    individual: { first_name: "Alice", last_name: "Racing" },
    payouts_enabled: true,
    capabilities: { transfers: "active" },
    settings: { payouts: { schedule: { interval: "manual" } } },
  };
  let bank = {
    id: "ba_bound",
    currency: "usd",
    default_for_currency: true,
    status: "verified",
    account_holder_name: "Alice Racing",
  };
  const stripe = {
    accounts: {
      retrieve: async () => account,
      listExternalAccounts: async () => ({ data: [bank] }),
    },
  };
  const options = {
    onboard: false,
    identity: { first_name: "Alice", last_name: "Racing" },
  };
  assert.equal(
    (await connectBank(customer, admin, T, env, stripe, options)).ready,
    true,
  );
  bank = { ...bank, account_holder_name: "Different Person" };
  assert.equal(
    (await connectBank(customer, admin, T, env, stripe, options)).ready,
    false,
  );
  bank = { ...bank, account_holder_name: "Alice Racing", status: "new" };
  assert.equal(
    (await connectBank(customer, admin, T, env, stripe, options)).ready,
    false,
  );
  assert.equal(bindings[0].p_ready, true);
  assert.equal(bindings[1].p_ready, false);
  assert.equal(bindings[2].p_ready, false);
});
