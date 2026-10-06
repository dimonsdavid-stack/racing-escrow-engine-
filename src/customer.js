import express from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callRpc, RpcError, retryable } from "./settlement.js";
import { commerceReady, createCheckout } from "./commerce.js";
import { beginIRacing, oauthReady, hashState, encrypt } from "./oauth.js";
import { randomBytes } from "node:crypto";
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
};
export function createCustomerRouter({
  env = process.env,
  makeClient = createClient,
  admin,
  stripe,
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
      redemption_available: false,
      practice_available: false,
    }),
  );
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
      { PT400: 400, PT403: 403, PT404: 404, PT409: 409, 23505: 409 }[code] ??
      (retryable(new RpcError(code)) ? 503 : 500);
    return res
      .status(status)
      .json({
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
  async function rpc(req, res, name, args) {
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
    try {
      return res.json(
        await createCheckout(req.customer, config.tenant, d.data, env, stripe),
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
