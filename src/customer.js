import express from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callRpc, RpcError, retryable } from "./settlement.js";
import { commerceReady, createCheckout } from "./commerce.js";
import { beginIRacing, oauthReady, hashState, encrypt } from "./oauth.js";
import { randomBytes } from "node:crypto";
import { kycReady, SumsubClient, refreshKyc } from "./kyc.js";
import { redemptionReady, connectBank } from "./redemption.js";
import { PUBLISHED_PACKAGES } from "./catalog.js";
export function customerConfig(env = process.env) {
  try {
    const url = new URL(env.SUPABASE_URL),
      tenant = z.uuid().parse(env.RACING_TENANT_ID),
      key = env.SUPABASE_PUBLISHABLE_KEY ?? "";
    let valid = /^sb_publishable_[A-Za-z0-9_-]{4,}$/.test(key);
    if (/^eyJ[A-Za-z0-9._-]+$/.test(key))
      try {
        valid =
          JSON.parse(
            Buffer.from(key.split(".")[1], "base64url").toString("utf8"),
          ).role === "anon";
      } catch {
        valid = false;
      }
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      !valid
    )
      return null;
    return { url: url.origin, key, tenant };
  } catch {
    return null;
  }
}
const specs = {
  enroll: [
    "race_enroll",
    z
      .object({
        handle: z.string().regex(/^[A-Za-z0-9_]{3,20}$/),
        accept_terms: z.literal(true),
      })
      .strict(),
    (d) => ({ p_handle: d.handle, p_accept_terms: d.accept_terms }),
  ],
  offers: [
    "sim_offer",
    z
      .object({
        request_id: z.uuid(),
        event_id: z.uuid(),
        mode: z.enum(["driver_duel", "event_match"]),
        token_type: z.enum(["GC", "SC"]),
        entry_fee: z.string().regex(/^\d{1,4}(?:\.\d{1,2})?$/),
        selection: z.string().min(1).max(80).nullable().optional(),
        target_id: z.uuid().nullable().optional(),
      })
      .strict(),
    (d) => ({
      p_request_id: d.request_id,
      p_event_id: d.event_id,
      p_mode: d.mode,
      p_token_type: d.token_type,
      p_entry_fee: d.entry_fee,
      p_selection: d.selection ?? null,
      p_target_id: d.target_id ?? null,
    }),
  ],
  accept: [
    "sim_accept",
    z
      .object({
        offer_id: z.uuid(),
        accept_terms: z.literal(true),
        selection: z.string().min(1).max(80).nullable().optional(),
      })
      .strict(),
    (d) => ({
      p_offer_id: d.offer_id,
      p_accept_terms: d.accept_terms,
      p_selection: d.selection ?? null,
    }),
  ],
  cancel: [
    "sim_cancel",
    z.object({ offer_id: z.uuid() }).strict(),
    (d) => ({ p_offer_id: d.offer_id }),
  ],
  daily: ["race_daily", z.object({}).strict(), () => ({})],
  pause: [
    "race_pause",
    z
      .object({ hours: z.union([z.literal(1), z.literal(24), z.literal(168)]) })
      .strict(),
    (d) => ({ p_hours: d.hours }),
  ],
  "request-result": [
    "sim_request_result",
    z.object({ challenge_id: z.uuid() }).strict(),
    (d) => ({ p_challenge_id: d.challenge_id }),
  ],
  "compliance/consent": [
    "grid_consent",
    z.object({ program_id: z.uuid(), accept_terms: z.literal(true) }).strict(),
    (d) => ({ p_program_id: d.program_id }),
  ],
  ame: [
    "grid_ame",
    z.object({ request_id: z.uuid(), program_id: z.uuid() }).strict(),
    (d) => ({ p_request_id: d.request_id, p_program_id: d.program_id }),
  ],
};
export function createCustomerRouter({
  env = process.env,
  makeClient = createClient,
  admin,
  stripe,
  kycProvider,
} = {}) {
  const r = express.Router(),
    config = customerConfig(env);
  r.get("/config", (_req, res) =>
    res.json({
      accounts_available: Boolean(config),
      supabase_url: config?.url ?? null,
      publishable_key: config?.key ?? null,
      tenant_id: config?.tenant ?? null,
      commerce_available: commerceReady(env),
      iracing_available: oauthReady(env) && Boolean(admin),
      steam_available: Boolean(
        admin && env.OAUTH_ENCRYPTION_KEY && env.APP_ORIGIN,
      ),
      redemption_available: Boolean(
        admin && config && redemptionReady(env) && kycReady(env),
      ),
      kyc_available: Boolean(admin && config && kycReady(env)),
      practice_available: false,
      package_catalog: PUBLISHED_PACKAGES,
      realtime_available: env.REALTIME_ENABLED === "true",
    }),
  );
  r.get("/program", async (_req, res) => {
    if (!config || !admin) return res.json({ program: null });
    try {
      return res.json(
        await callRpc(admin, "grid_program", { p_tenant_id: config.tenant }),
      );
    } catch {
      return res.status(503).json({ error: "program_rules_unavailable" });
    }
  });
  r.use(async (req, res, next) => {
    if (!config)
      return res.status(503).json({ error: "accounts_not_activated" });
    const match = /^Bearer ([A-Za-z0-9._-]{20,8192})$/.exec(
      req.get("authorization") ?? "",
    );
    if (!match) return res.status(401).json({ error: "sign_in_required" });
    req.customer = makeClient(config.url, config.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { Authorization: `Bearer ${match[1]}` },
        fetch: (input, init = {}) =>
          fetch(input, {
            ...init,
            signal: init.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000),
          }),
      },
    });
    try {
      const { data, error } = await req.customer.auth.getUser(match[1]);
      if (error || !data.user?.email_confirmed_at || data.user.is_anonymous)
        return res.status(401).json({ error: "verified_account_required" });
      req.user = data.user;
      next();
    } catch {
      return res.status(503).json({ error: "authentication_unavailable" });
    }
  });
  function reject(res, error) {
    const code = error instanceof RpcError ? error.code : "NETWORK";
    const status =
      {
        PT400: 400,
        PT403: 403,
        PT404: 404,
        PT409: 409,
        PT429: 429,
        23505: 409,
      }[code] ?? (retryable(new RpcError(code)) ? 503 : 500);
    if (status === 429) res.set("Retry-After", "60");
    return res.status(status).json({
      error:
        status === 409
          ? "profile_or_challenge_conflict"
          : status === 403
            ? "account_or_currency_unavailable"
            : status === 503
              ? "retry_same_request"
              : "request_rejected",
    });
  }
  async function budget(req, res, operation) {
    try {
      const result = await callRpc(
        req.customer,
        "grid_request_budget",
        { p_tenant_id: config.tenant, p_operation: operation },
        { attempts: 1 },
      );
      if (result.allowed !== true) {
        res.set("Retry-After", String(Math.max(1, result.retry_after || 60)));
        res.status(429).json({ error: "request_limit_reached" });
        return false;
      }
      return true;
    } catch (e) {
      reject(res, e);
      return false;
    }
  }
  async function rpc(req, res, name, args) {
    if (!(await budget(req, res, req.method === "GET" ? "read" : "mutate")))
      return;
    try {
      return res.json(
        await callRpc(req.customer, name, {
          p_tenant_id: config.tenant,
          ...args,
        }),
      );
    } catch (e) {
      return reject(res, e);
    }
  }
  r.get("/me", (req, res) => rpc(req, res, "sim_state", {}));
  r.get("/lobby", (req, res) => rpc(req, res, "sim_lobby", {}));
  r.get("/catalog", (req, res) => rpc(req, res, "sim_catalog", {}));
  r.get("/compliance", (req, res) => rpc(req, res, "grid_compliance", {}));
  r.get("/redemptions", (req, res) => rpc(req, res, "cash_state", {}));
  r.get("/audit", (req, res) => rpc(req, res, "grid_wallet_audit", {}));
  r.use(express.json({ limit: "16kb", strict: true }));
  for (const [path, [name, schema, args]] of Object.entries(specs))
    r.post("/" + path, (req, res) => {
      const d = schema.safeParse(req.body);
      if (!d.success) return res.status(422).json({ error: "invalid_request" });
      return rpc(req, res, name, args(d.data));
    });
  r.post("/checkout", async (req, res) => {
    const d = z
      .object({
        order_id: z.uuid(),
        package_id: z.string().regex(/^[a-z0-9_]{1,60}$/),
      })
      .strict()
      .safeParse(req.body);
    if (!d.success) return res.status(422).json({ error: "invalid_request" });
    if (!commerceReady(env))
      return res.status(503).json({ error: "commerce_not_activated" });
    if (!(await budget(req, res, "checkout"))) return;
    try {
      return res.json(
        await createCheckout(req.customer, config.tenant, d.data, env, stripe),
      );
    } catch (e) {
      return reject(res, e);
    }
  });
  r.post("/kyc/start", async (req, res) => {
    if (Object.keys(req.body ?? {}).length)
      return res.status(422).json({ error: "invalid_request" });
    if (!admin || !kycReady(env))
      return res.status(503).json({ error: "verification_not_configured" });
    if (!(await budget(req, res, "identity"))) return;
    try {
      const context = await callRpc(req.customer, "cash_begin_kyc", {
        p_tenant_id: config.tenant,
      });
      return res.json(
        await (kycProvider ?? new SumsubClient(env)).link(
          context.external_user_id,
        ),
      );
    } catch (e) {
      return reject(res, e);
    }
  });
  r.post("/bank/connect", async (req, res) => {
    if (Object.keys(req.body ?? {}).length)
      return res.status(422).json({ error: "invalid_request" });
    if (!admin || !redemptionReady(env))
      return res.status(503).json({ error: "live_payouts_not_configured" });
    if (!(await budget(req, res, "identity"))) return;
    try {
      return res.json(
        await connectBank(req.customer, admin, config.tenant, env, stripe),
      );
    } catch (e) {
      return reject(res, e);
    }
  });
  r.post("/redeem", async (req, res) => {
    const body = z
      .object({
        request_id: z.uuid(),
        amount_sc: z.string().regex(/^\d{1,5}(?:\.\d{1,2})?$/),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return res.status(422).json({ error: "invalid_request" });
    if (!admin || !redemptionReady(env) || !kycReady(env))
      return res.status(503).json({ error: "live_redemptions_not_configured" });
    if (!(await budget(req, res, "mutate"))) return;
    try {
      const state = await callRpc(req.customer, "cash_state", {
        p_tenant_id: config.tenant,
      });
      if (!state.requests.some((x) => x.id === body.data.request_id)) {
        if (!state.kyc_reference_id)
          return res
            .status(403)
            .json({ error: "identity_verification_required" });
        const verification = await refreshKyc(
          admin,
          env,
          config.tenant,
          req.user.id,
          state.kyc_reference_id,
          kycProvider ?? new SumsubClient(env),
        );
        const bank = await connectBank(
          req.customer,
          admin,
          config.tenant,
          env,
          stripe,
          { onboard: false, identity: verification.identity },
        );
        if (!bank.ready)
          return res.status(403).json({ error: "bank_verification_required" });
      }
      return res.status(202).json(
        await callRpc(req.customer, "execute_atomic_withdrawal_debit", {
          p_tenant_id: config.tenant,
          p_request_id: body.data.request_id,
          p_amount_sc: body.data.amount_sc,
        }),
      );
    } catch (e) {
      return reject(res, e);
    }
  });
  r.post("/identity/discord", async (req, res) => {
    if (!admin)
      return res.status(503).json({ error: "identity_not_activated" });
    if (Object.keys(req.body ?? {}).length)
      return res.status(422).json({ error: "invalid_request" });
    if (!(await budget(req, res, "identity"))) return;
    try {
      await callRpc(req.customer, "sim_state", { p_tenant_id: config.tenant });
      // Auth identities are supplied by Supabase's verified provider callback, never user_metadata.
      const identity = req.user.identities?.find(
        (x) => x.provider === "discord",
      );
      const id =
        identity?.identity_data?.provider_id ?? identity?.identity_data?.sub;
      if (typeof id !== "string" || !/^\d{17,20}$/.test(id))
        return res
          .status(409)
          .json({ error: "sign_in_with_discord_to_connect" });
      return res.json(
        await callRpc(admin, "sim_link_identity", {
          p_tenant_id: config.tenant,
          p_auth_user_id: req.user.id,
          p_provider: "discord",
          p_external_id: id,
        }),
      );
    } catch (e) {
      return reject(res, e);
    }
  });
  r.post("/identity/iracing", async (req, res) => {
    if (!admin || !oauthReady(env))
      return res.status(503).json({ error: "iracing_not_activated" });
    if (Object.keys(req.body ?? {}).length)
      return res.status(422).json({ error: "invalid_request" });
    if (!(await budget(req, res, "identity"))) return;
    try {
      await callRpc(req.customer, "sim_state", { p_tenant_id: config.tenant });
      const auth = await beginIRacing(admin, config.tenant, req.user.id, env);
      res.cookie("racing_iracing", auth.state, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 600000,
        path: "/api/v1/identity/iracing",
      });
      return res.json({ url: auth.url });
    } catch (e) {
      return reject(res, e);
    }
  });
  r.post("/identity/steam", async (req, res) => {
    if (!admin || !env.OAUTH_ENCRYPTION_KEY || !env.APP_ORIGIN)
      return res.status(503).json({ error: "steam_not_activated" });
    if (Object.keys(req.body ?? {}).length)
      return res.status(422).json({ error: "invalid_request" });
    if (!(await budget(req, res, "identity"))) return;
    try {
      await callRpc(req.customer, "sim_state", { p_tenant_id: config.tenant });
      const state = randomBytes(32).toString("base64url"),
        origin = new URL(env.APP_ORIGIN);
      if (origin.protocol !== "https:") throw new Error("invalid_origin");
      await callRpc(admin, "sim_oauth_begin", {
        p_tenant_id: config.tenant,
        p_auth_user_id: req.user.id,
        p_provider: "steam",
        p_state_hash: hashState(state),
        p_verifier_cipher: encrypt(state, env),
      });
      const url = new URL("https://steamcommunity.com/openid/login");
      const fields = {
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to":
          origin.origin + "/api/v1/identity/steam/callback?state=" + state,
        "openid.realm": origin.origin,
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id":
          "http://specs.openid.net/auth/2.0/identifier_select",
      };
      for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, v);
      res.cookie("racing_steam", state, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 600000,
        path: "/api/v1/identity/steam",
      });
      return res.json({ url: url.href });
    } catch (e) {
      return reject(res, e);
    }
  });
  return r;
}
