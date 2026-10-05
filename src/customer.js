import express from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callRpc, RpcError, retryable } from "./settlement.js";

export const TRACKS = [
  {
    id: "coastal",
    title: "Coastal Sprint",
    description: "Open sweepers. Find your rhythm.",
    difficulty: "Rookie",
    length: "1.4 km",
    theme: "coastal",
    laps: 3,
  },
  {
    id: "club",
    title: "Club Circuit",
    description: "Tighter turns. Precision wins.",
    difficulty: "Sport",
    length: "1.1 km",
    theme: "club",
    laps: 3,
  },
  {
    id: "night",
    title: "Night Run",
    description: "Under the lights. Own the apex.",
    difficulty: "Pro",
    length: "1.6 km",
    theme: "night",
    laps: 3,
  },
];
export function customerConfig(env = process.env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    const tenant = z.uuid().parse(env.RACING_TENANT_ID);
    const key = env.SUPABASE_PUBLISHABLE_KEY || "";
    const publishable = /^sb_publishable_[A-Za-z0-9_-]{4,}$/.test(key);
    let legacyAnon = false;
    if (/^eyJ[A-Za-z0-9._-]+$/.test(key)) {
      try {
        legacyAnon =
          JSON.parse(
            Buffer.from(key.split(".")[1], "base64url").toString("utf8"),
          ).role === "anon";
      } catch {
        /* Invalid keys never enter public configuration. */
      }
    }
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      !(publishable || legacyAnon)
    )
      return null;
    return { url: url.origin, key: env.SUPABASE_PUBLISHABLE_KEY, tenant };
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
    "race_offer",
    z
      .object({
        request_id: z.uuid(),
        track_id: z.enum(["coastal", "club", "night"]),
        token_type: z.enum(["GC", "SC"]),
        entry_fee: z.string().regex(/^\d{1,4}(?:\.\d{1,2})?$/),
      })
      .strict(),
    (d) => ({
      p_request_id: d.request_id,
      p_track_id: d.track_id,
      p_token_type: d.token_type,
      p_entry_fee: d.entry_fee,
    }),
  ],
  accept: [
    "race_accept",
    z.object({ offer_id: z.uuid(), accept_terms: z.literal(true) }).strict(),
    (d) => ({ p_offer_id: d.offer_id, p_accept_terms: d.accept_terms }),
  ],
  cancel: [
    "race_cancel",
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
};
export function createCustomerRouter({
  env = process.env,
  makeClient = createClient,
} = {}) {
  const router = express.Router(),
    config = customerConfig(env);
  router.get("/config", (_req, res) =>
    res.json({
      accounts_available: Boolean(config),
      supabase_url: config?.url ?? null,
      publishable_key: config?.key ?? null,
      tenant_id: config?.tenant ?? null,
      practice_available: true,
      commerce_available: false,
      redemption_available: false,
    }),
  );
  router.get("/tracks", (_req, res) => res.json({ tracks: TRACKS }));
  router.use(async (req, res, next) => {
    if (!config)
      return res.status(503).json({ error: "accounts_not_activated" });
    const match = /^Bearer ([A-Za-z0-9._-]{20,8192})$/.exec(
      req.get("authorization") ?? "",
    );
    if (!match) return res.status(401).json({ error: "sign_in_required" });
    // Dedicated per-request client. Never persist a customer's session globally.
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
      if (
        error ||
        !data.user ||
        !data.user.email_confirmed_at ||
        data.user.is_anonymous
      )
        return res.status(401).json({ error: "verified_account_required" });
      next();
    } catch {
      return res.status(503).json({ error: "authentication_unavailable" });
    }
  });
  async function rpc(req, res, name, args) {
    try {
      return res.json(
        await callRpc(req.customer, name, {
          p_tenant_id: config.tenant,
          ...args,
        }),
      );
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "NETWORK";
      const status =
        { PT400: 400, PT403: 403, PT404: 404, PT409: 409, 23505: 409 }[code] ??
        (retryable(new RpcError(code)) ? 503 : 500);
      return res.status(status).json({
        error:
          status === 409
            ? "race_conflict_or_profile_required"
            : status === 403
              ? "play_not_available"
              : status === 503
                ? "retry_same_request"
                : "request_rejected",
      });
    }
  }
  router.get("/me", (req, res) => rpc(req, res, "race_state", {}));
  router.get("/lobby", (req, res) => rpc(req, res, "race_lobby", {}));
  // This JSON parser is mounted after the raw signed telemetry route.
  router.use(express.json({ limit: "16kb", strict: true }));
  for (const [path, [name, schema, args]] of Object.entries(specs))
    router.post("/" + path, (req, res) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success)
        return res.status(422).json({ error: "invalid_request" });
      return rpc(req, res, name, args(parsed.data));
    });
  return router;
}
