import Stripe from "stripe";
import { createHash } from "node:crypto";
import { callRpc } from "./settlement.js";
export function redemptionReady(env) {
  return (
    /^sk_live_/.test(env.STRIPE_SECRET_KEY ?? "") &&
    env.COMMERCE_APPROVED === "true" &&
    /^https:\/\//.test(env.APP_ORIGIN ?? "")
  );
}
export function payoutClient(env = process.env) {
  if (!redemptionReady(env)) throw new Error("live_payouts_not_configured");
  return new Stripe(env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 10000,
  });
}
function ownedAccount(a, tenant, user, intent) {
  if (
    a.deleted ||
    a.metadata?.tenant_id !== tenant ||
    a.metadata?.user_id !== user ||
    a.metadata?.intent_id !== intent ||
    a.type !== "express" ||
    a.country !== "US" ||
    a.settings?.payouts?.schedule?.interval !== "manual"
  )
    throw new Error("payout_account_binding_failed");
  return a;
}
export async function connectBank(
  customer,
  admin,
  tenant,
  env = process.env,
  stripe = payoutClient(env),
  { onboard = true, identity = null } = {},
) {
  const context = await callRpc(customer, "cash_begin_account", {
    p_tenant_id: tenant,
  });
  let a;
  if (context.account_id)
    a = await stripe.accounts.retrieve(context.account_id);
  else {
    if (Date.now() - Date.parse(context.started_at) >= 23 * 3600000)
      throw new Error("account_creation_requires_reconciliation");
    a = await stripe.accounts.create(
      {
        type: "express",
        business_type: "individual",
        country: "US",
        capabilities: { transfers: { requested: true } },
        settings: { payouts: { schedule: { interval: "manual" } } },
        metadata: {
          tenant_id: tenant,
          user_id: context.user_id,
          intent_id: context.intent_id,
        },
      },
      { idempotencyKey: `bank:${tenant}:${context.intent_id}` },
    );
  }
  ownedAccount(a, tenant, context.user_id, context.intent_id);
  const banks = await stripe.accounts.listExternalAccounts(a.id, {
    object: "bank_account",
    limit: 100,
  });
  const bank = banks.data.find(
    (b) =>
      b.currency === "usd" &&
      b.default_for_currency === true &&
      b.status === "verified",
  );
  const normalize = (value) =>
    typeof value === "string"
      ? value
          .normalize("NFKD")
          .replace(/\p{M}/gu, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, "")
      : "";
  const verifiedName = normalize(
    (identity?.first_name ?? "") + " " + (identity?.last_name ?? ""),
  );
  const accountName = normalize(
    (a.individual?.first_name ?? "") + " " + (a.individual?.last_name ?? ""),
  );
  const nameMatches = Boolean(
    identity?.first_name &&
    identity?.last_name &&
    verifiedName &&
    verifiedName === accountName &&
    verifiedName === normalize(bank?.account_holder_name),
  );
  const ready = Boolean(
    a.business_type === "individual" &&
    nameMatches &&
    a.payouts_enabled &&
    a.capabilities?.transfers === "active" &&
    !a.requirements?.disabled_reason &&
    bank,
  );
  await callRpc(admin, "cash_bind_account", {
    p_tenant_id: tenant,
    p_user_id: context.user_id,
    p_intent_id: context.intent_id,
    p_account_id: a.id,
    p_bank_id: bank?.id ?? null,
    p_ready: ready,
  });
  if (!onboard) return { ready };
  const origin = new URL(env.APP_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("invalid_app_origin");
  const link = await stripe.accountLinks.create({
    account: a.id,
    type: "account_onboarding",
    refresh_url: origin.origin + "/#wallet",
    return_url: origin.origin + "/#wallet",
  });
  const url = new URL(link.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "connect.stripe.com" ||
    url.username ||
    url.password
  )
    throw new Error("invalid_onboarding_url");
  return { url: url.href };
}
const proofHash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function reconcileRedemption(
  admin,
  stripe,
  job,
  { now = () => Date.now() } = {},
) {
  let j = { ...job };
  const args = () => ({
    p_tenant_id: j.tenant_id,
    p_request_id: j.id,
    p_lease_token: job.lease_token,
  });
  async function record(phase, obj, id = obj.id) {
    const sha = proofHash(obj);
    await callRpc(admin, "cash_record", {
      ...args(),
      p_phase: phase,
      p_object_id: id,
      p_receipt_id: `${phase}:${j.id}:${sha}`,
      p_sha256: sha,
    });
  }
  async function start(phase) {
    j = {
      ...j,
      ...(await callRpc(admin, "cash_start_phase", {
        ...args(),
        p_phase: phase,
      })),
    };
  }
  const meta = {
    tenant_id: j.tenant_id,
    redemption_id: j.id,
    user_id: j.user_id,
  };
  function transferProof(t) {
    if (
      t.amount !== j.amount_cents ||
      t.currency !== "usd" ||
      t.destination !== j.account_id ||
      t.metadata?.tenant_id !== j.tenant_id ||
      t.metadata?.redemption_id !== j.id ||
      t.metadata?.user_id !== j.user_id
    )
      throw new Error("transfer_binding_failed");
    return t;
  }
  function payoutProof(p) {
    if (
      p.amount !== j.amount_cents ||
      p.currency !== "usd" ||
      p.destination !== j.bank_id ||
      p.metadata?.tenant_id !== j.tenant_id ||
      p.metadata?.redemption_id !== j.id ||
      p.metadata?.user_id !== j.user_id
    )
      throw new Error("payout_binding_failed");
    return p;
  }
  async function recover(kind, started) {
    let after;
    for (let page = 0; page < 20; page++) {
      const params = {
        limit: 100,
        created: { gte: Math.floor(Date.parse(started) / 1000) - 60 },
        ...(after ? { starting_after: after } : {}),
      };
      if (kind === "transfer") {
        params.destination = j.account_id;
        params.transfer_group = `redemption:${j.tenant_id}:${j.id}`;
      }
      const result =
        kind === "transfer"
          ? await stripe.transfers.list(params)
          : await stripe.payouts.list(params, { stripeAccount: j.account_id });
      const found = result.data.filter(
        (x) =>
          x.metadata?.redemption_id === j.id &&
          x.metadata?.tenant_id === j.tenant_id,
      );
      if (found.length > 1) throw new Error("multiple_provider_objects");
      if (found.length === 1)
        return kind === "transfer"
          ? transferProof(found[0])
          : payoutProof(found[0]);
      if (!result.has_more) return null;
      after = result.data.at(-1)?.id;
      if (!after) throw new Error("invalid_provider_page");
    }
    throw new Error("reconciliation_page_limit");
  }
  if (j.state === "Reserved") {
    const began = j.transfer_started_at;
    await start("transfer");
    let t = began ? await recover("transfer", began) : null;
    if (!t && now() - Date.parse(j.transfer_started_at) >= 23 * 3600000) {
      await record("review", {
        id: "unknown_transfer",
        reason: "idempotency_window_expired",
      });
      return;
    }
    if (!t) {
      const a = await stripe.accounts.retrieve(j.account_id);
      if (
        a.deleted ||
        a.metadata?.tenant_id !== j.tenant_id ||
        a.metadata?.user_id !== j.user_id ||
        !a.payouts_enabled ||
        a.capabilities?.transfers !== "active" ||
        a.settings?.payouts?.schedule?.interval !== "manual"
      )
        throw new Error("bank_not_ready");
      t = transferProof(
        await stripe.transfers.create(
          {
            amount: j.amount_cents,
            currency: "usd",
            destination: j.account_id,
            transfer_group: `redemption:${j.tenant_id}:${j.id}`,
            metadata: meta,
          },
          { idempotencyKey: `transfer:${j.tenant_id}:${j.id}` },
        ),
      );
    }
    await record("transfer", t);
    j.transfer_id = t.id;
    j.state = "Transferred";
  }
  if (j.state === "Transferred") {
    const t = transferProof(await stripe.transfers.retrieve(j.transfer_id));
    if (t.amount_reversed !== 0) {
      await record("review", {
        id: t.id,
        reason: "unexpected_transfer_reversal",
      });
      return;
    }
    const began = j.payout_started_at;
    await start("payout");
    let p = began ? await recover("payout", began) : null;
    if (!p && now() - Date.parse(j.payout_started_at) >= 23 * 3600000) {
      await record("review", {
        id: "unknown_payout",
        reason: "idempotency_window_expired",
      });
      return;
    }
    if (!p)
      p = payoutProof(
        await stripe.payouts.create(
          {
            amount: j.amount_cents,
            currency: "usd",
            destination: j.bank_id,
            method: "standard",
            metadata: meta,
          },
          {
            stripeAccount: j.account_id,
            idempotencyKey: `payout:${j.tenant_id}:${j.id}`,
          },
        ),
      );
    await record("payout", p);
    j.payout_id = p.id;
    j.state = "PayoutPending";
  }
  if (["PayoutPending", "Paid"].includes(j.state)) {
    const p = payoutProof(
      await stripe.payouts.retrieve(j.payout_id, {
        stripeAccount: j.account_id,
      }),
    );
    if (p.status === "paid" && j.state === "PayoutPending") {
      await record("paid", p);
      return;
    }
    if (["failed", "canceled"].includes(p.status)) {
      await record("failed", p);
      j.state = "Reversing";
    } else return;
  }
  if (j.state === "Reversing") {
    // A bank failure does not justify minting SC while the connected account
    // still holds the transferred funds. Verify the complete reversal first.
    const p = payoutProof(
      await stripe.payouts.retrieve(j.payout_id, {
        stripeAccount: j.account_id,
      }),
    );
    if (!["failed", "canceled"].includes(p.status))
      throw new Error("failure_not_confirmed");
    await start("reversal");
    let t = transferProof(await stripe.transfers.retrieve(j.transfer_id));
    if (t.amount_reversed !== 0 && t.amount_reversed !== j.amount_cents) {
      await record("review", { id: t.id, reason: "partial_reversal" });
      return;
    }
    if (t.amount_reversed === 0) {
      if (now() - Date.parse(j.reversal_started_at) >= 23 * 3600000) {
        await record("review", {
          id: t.id,
          reason: "reversal_reconciliation_required",
        });
        return;
      }
      await stripe.transfers.createReversal(
        t.id,
        { amount: j.amount_cents, metadata: meta },
        { idempotencyKey: `reversal:${j.tenant_id}:${j.id}` },
      );
      t = transferProof(await stripe.transfers.retrieve(t.id));
    }
    if (t.amount_reversed !== j.amount_cents || t.reversed !== true)
      throw new Error("reversal_not_confirmed");
    await record("returned", t);
  }
}
