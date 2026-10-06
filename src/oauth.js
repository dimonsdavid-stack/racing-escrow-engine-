import express from "express";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { callRpc } from "./settlement.js";
import { IRacingDataClient, maskIRacingSecret } from "./providers.js";
export const hashState = (v) => createHash("sha256").update(v).digest("hex");
function encryptionKey(env) {
  const k = Buffer.from(env.OAUTH_ENCRYPTION_KEY ?? "", "base64");
  if (k.length !== 32 || k.toString("base64") !== env.OAUTH_ENCRYPTION_KEY)
    throw new Error("oauth_encryption_configuration_required");
  return k;
}
export function encrypt(value, env) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function decrypt(value, env) {
  const [iv, tag, data] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(env), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
export function oauthReady(env) {
  try {
    encryptionKey(env);
    return Boolean(
      env.IRACING_CLIENT_ID &&
      new URL(env.APP_ORIGIN).protocol === "https:" &&
      env.IRACING_DOWNLOAD_HOSTS,
    );
  } catch {
    return false;
  }
}
export async function beginIRacing(client, tenant, userId, env) {
  if (!oauthReady(env)) throw new Error("iracing_not_activated");
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  await callRpc(client, "sim_oauth_begin", {
    p_tenant_id: tenant,
    p_auth_user_id: userId,
    p_provider: "iracing",
    p_state_hash: hashState(state),
    p_verifier_cipher: encrypt(verifier, env),
  });
  const url = new URL("https://oauth.iracing.com/oauth2/authorize");
  const params = {
    client_id: env.IRACING_CLIENT_ID,
    response_type: "code",
    redirect_uri: new URL("/api/v1/identity/iracing/callback", env.APP_ORIGIN)
      .href,
    scope: "iracing.auth",
    state,
    code_challenge: hashPKCE(verifier),
    code_challenge_method: "S256",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { state, url: url.href };
}
export function hashPKCE(v) {
  return createHash("sha256").update(v).digest("base64url");
}
export function createOAuthRouter({
  client,
  env = process.env,
  fetcher = fetch,
} = {}) {
  const router = express.Router();
  router.get("/api/v1/identity/iracing/callback", async (req, res) => {
    if (!client || !oauthReady(env))
      return res.status(503).send("iRacing connection is not activated.");
    const state = req.query.state,
      code = req.query.code;
    const cookie = /(?:^|;\s*)racing_iracing=([^;]+)/.exec(
      req.get("cookie") ?? "",
    )?.[1];
    res.clearCookie("racing_iracing", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/v1/identity/iracing",
    });
    if (
      typeof state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      typeof code !== "string" ||
      code.length > 2048 ||
      !cookie ||
      !timingSafeEqual(
        Buffer.from(hashState(state), "hex"),
        Buffer.from(hashState(cookie), "hex"),
      )
    )
      return res
        .status(400)
        .send("The connection expired. Start again from your account.");
    try {
      const s = await callRpc(client, "sim_oauth_consume", {
        p_state_hash: hashState(state),
        p_provider: "iracing",
      });
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.IRACING_CLIENT_ID,
        code,
        redirect_uri: new URL(
          "/api/v1/identity/iracing/callback",
          env.APP_ORIGIN,
        ).href,
        code_verifier: decrypt(s.verifier_cipher, env),
      });
      if (env.IRACING_CLIENT_SECRET)
        body.set(
          "client_secret",
          maskIRacingSecret(env.IRACING_CLIENT_SECRET, env.IRACING_CLIENT_ID),
        );
      const response = await fetcher("https://oauth.iracing.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error("oauth_rejected");
      const token = await response.json();
      if (
        typeof token.access_token !== "string" ||
        !Number.isSafeInteger(token.expires_in) ||
        token.expires_in < 1 ||
        token.expires_in > 86400
      )
        throw new Error("invalid_token_response");
      const api = new IRacingDataClient({
        accessToken: token.access_token,
        downloadHosts: new Set(
          env.IRACING_DOWNLOAD_HOSTS.split(",").map((x) => x.trim()),
        ),
        fetcher,
      });
      const member = await api.data("/data/member/info");
      const cust = member.cust_id ?? member.member?.cust_id;
      if (!Number.isSafeInteger(cust) || cust <= 0)
        throw new Error("unverified_member");
      await callRpc(client, "sim_link_identity", {
        p_tenant_id: s.tenant_id,
        p_auth_user_id: s.auth_user_id,
        p_provider: "iracing",
        p_external_id: String(cust),
      });
      await callRpc(client, "sim_store_token", {
        p_tenant_id: s.tenant_id,
        p_auth_user_id: s.auth_user_id,
        p_cipher: encrypt(JSON.stringify(token), env),
        p_expires_at: new Date(
          Date.now() + token.expires_in * 1000,
        ).toISOString(),
      });
      return res.redirect(
        303,
        new URL("/#identity?connected=iracing", env.APP_ORIGIN).href,
      );
    } catch {
      return res
        .status(502)
        .send(
          "iRacing could not verify the connection. Your balances have not changed. Start the connection again.",
        );
    }
  });
  return router;
}

export function createSteamRouter({
  client,
  env = process.env,
  fetcher = fetch,
} = {}) {
  const r = express.Router();
  r.get("/api/v1/identity/steam/callback", async (req, res) => {
    if (!client || !env.APP_ORIGIN)
      return res.status(503).send("Steam connection is not activated.");
    const state = req.query.state,
      cookie = /(?:^|;\s*)racing_steam=([^;]+)/.exec(
        req.get("cookie") ?? "",
      )?.[1];
    res.clearCookie("racing_steam", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/v1/identity/steam",
    });
    if (
      typeof state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !cookie ||
      hashState(state) !== hashState(cookie)
    )
      return res.status(400).send("The Steam connection expired. Start again.");
    try {
      const endpoint = req.query["openid.op_endpoint"],
        claimed = req.query["openid.claimed_id"],
        identity = req.query["openid.identity"],
        nonce = req.query["openid.response_nonce"];
      const expected = new URL(
        "/api/v1/identity/steam/callback",
        env.APP_ORIGIN,
      );
      expected.searchParams.set("state", state);
      if (
        endpoint !== "https://steamcommunity.com/openid/login" ||
        typeof claimed !== "string" ||
        !/^https:\/\/steamcommunity\.com\/openid\/id\/\d{17}$/.test(claimed) ||
        identity !== claimed ||
        req.query["openid.return_to"] !== expected.href ||
        req.query["openid.mode"] !== "id_res" ||
        typeof nonce !== "string" ||
        !Number.isFinite(Date.parse(nonce.slice(0, 20))) ||
        Math.abs(Date.now() - Date.parse(nonce.slice(0, 20))) > 600000
      )
        throw new Error("invalid_steam_binding");
      const signed = String(req.query["openid.signed"] ?? "").split(",");
      if (
        ![
          "op_endpoint",
          "claimed_id",
          "identity",
          "return_to",
          "response_nonce",
          "assoc_handle",
        ].every((x) => signed.includes(x))
      )
        throw new Error("unsigned_steam_claim");
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query))
        if (k.startsWith("openid.") && typeof v === "string") body.set(k, v);
      body.set("openid.mode", "check_authentication");
      const response = await fetcher(
        "https://steamcommunity.com/openid/login",
        {
          method: "POST",
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (
        !response.ok ||
        !(await response.text())
          .split("\n")
          .some((x) => x.trim() === "is_valid:true")
      )
        throw new Error("steam_rejected");
      const s = await callRpc(client, "sim_oauth_consume", {
        p_state_hash: hashState(state),
        p_provider: "steam",
      });
      await callRpc(client, "sim_link_identity", {
        p_tenant_id: s.tenant_id,
        p_auth_user_id: s.auth_user_id,
        p_provider: "acc",
        p_external_id: "steam_" + claimed.split("/").at(-1),
      });
      return res.redirect(
        303,
        new URL("/#identity?connected=steam", env.APP_ORIGIN).href,
      );
    } catch {
      return res
        .status(502)
        .send(
          "Steam could not verify your account. Start the connection again.",
        );
    }
  });
  return r;
}

export async function operatorAccessToken(
  client,
  tenant,
  userId,
  env,
  fetcher = fetch,
) {
  const args = { p_tenant_id: tenant, p_auth_user_id: userId };
  const lease = await callRpc(client, "sim_token_lease", args);
  if (lease.mode === "busy" || lease.mode === "reconnect")
    throw new Error("operator_access_unavailable");
  const token = JSON.parse(decrypt(lease.cipher, env));
  if (lease.mode === "access") return token.access_token;
  if (typeof token.refresh_token !== "string")
    throw new Error("operator_reconnect_required");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.IRACING_CLIENT_ID,
    refresh_token: token.refresh_token,
  });
  if (env.IRACING_CLIENT_SECRET)
    body.set(
      "client_secret",
      maskIRacingSecret(env.IRACING_CLIENT_SECRET, env.IRACING_CLIENT_ID),
    );
  // Exactly one external refresh attempt. The durable lease prevents replay after
  // network ambiguity, including worker crashes between response and persistence.
  const r = await fetcher("https://oauth.iracing.com/oauth2/token", {
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("refresh_reconnect_required");
  const fresh = await r.json();
  if (
    typeof fresh.access_token !== "string" ||
    typeof fresh.refresh_token !== "string" ||
    !Number.isSafeInteger(fresh.expires_in) ||
    fresh.expires_in < 1 ||
    fresh.expires_in > 86400
  )
    throw new Error("invalid_refresh_response");
  await callRpc(client, "sim_token_commit", {
    ...args,
    p_lease: lease.lease,
    p_version: lease.version,
    p_cipher: encrypt(JSON.stringify(fresh), env),
    p_expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
  });
  return fresh.access_token;
}
