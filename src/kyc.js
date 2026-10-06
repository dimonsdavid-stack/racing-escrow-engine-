import express from "express";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { callRpc } from "./settlement.js";
export function kycReady(env) {
  return Boolean(
    env.SUMSUB_APP_TOKEN &&
    env.SUMSUB_SECRET_KEY &&
    env.SUMSUB_WEBHOOK_SECRET &&
    env.SUMSUB_LEVEL_NAME &&
    env.SUMSUB_WEBSDK_HOST,
  );
}
export class SumsubClient {
  constructor(env = process.env, transport = fetch) {
    this.env = env;
    this.transport = transport;
  }
  async request(method, path, data) {
    if (!kycReady(this.env) || !path.startsWith("/resources/"))
      throw new Error("kyc_not_configured");
    const body = data === undefined ? "" : JSON.stringify(data),
      ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", this.env.SUMSUB_SECRET_KEY)
      .update(ts + method + path + body)
      .digest("hex");
    const response = await this.transport("https://api.sumsub.com" + path, {
      method,
      headers: {
        "X-App-Token": this.env.SUMSUB_APP_TOKEN,
        "X-App-Access-Ts": ts,
        "X-App-Access-Sig": sig,
        "Content-Type": "application/json",
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("kyc_provider_unavailable");
    return response.json();
  }
  async link(externalId) {
    const result = await this.request(
      "POST",
      "/resources/sdkIntegrations/levels/-/websdkLink",
      {
        levelName: this.env.SUMSUB_LEVEL_NAME,
        userId: externalId,
        ttlInSecs: 600,
      },
    );
    const url = new URL(result.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== this.env.SUMSUB_WEBSDK_HOST ||
      !/(^|\.)sumsub\.com$/.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("invalid_verification_url");
    return { url: url.href };
  }
  async inspect(applicantId, externalId) {
    if (!/^[a-f0-9]{24}$/.test(applicantId))
      throw new Error("invalid_applicant");
    const observed = new Date().toISOString();
    const a = await this.request(
      "GET",
      `/resources/applicants/${applicantId}/one`,
    );
    const review = await this.request(
      "GET",
      `/resources/applicants/${applicantId}/status`,
    );
    if (
      a.id !== applicantId ||
      a.externalUserId !== externalId ||
      a.type !== "individual" ||
      a.review?.levelName !== this.env.SUMSUB_LEVEL_NAME ||
      a.sandboxMode === true
    )
      throw new Error("applicant_binding_failed");
    const decision =
      review.reviewStatus === "completed"
        ? review.reviewResult?.reviewAnswer
        : null;
    const status =
      decision === "GREEN"
        ? "Verified"
        : decision === "RED"
          ? "Unverified"
          : "Pending";
    // Keep documents and bank details at the provider. A successful hosted return
    // is never proof of identity; only current authenticated provider results are.
    const snapshot = {
      applicant_id: applicantId,
      external_id: externalId,
      level: this.env.SUMSUB_LEVEL_NAME,
      status,
      review_id: review.reviewId ?? a.review?.reviewId ?? null,
      review_date: review.reviewDate ?? a.review?.reviewDate ?? null,
      observed,
    };
    const sha = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    return { status, observed, sha };
  }
}
export async function refreshKyc(
  admin,
  env,
  tenant,
  actor,
  applicant,
  client = new SumsubClient(env),
) {
  const data = await client.inspect(applicant, `${tenant}:${actor}`);
  await callRpc(admin, "cash_record_kyc", {
    p_tenant_id: tenant,
    p_auth_user_id: actor,
    p_receipt_id: `inspection:${data.sha}`,
    p_applicant_id: applicant,
    p_status: data.status,
    p_observed_at: data.observed,
    p_sha256: data.sha,
  });
  return data;
}
export function createKycRouter({
  admin,
  env = process.env,
  provider = new SumsubClient(env),
} = {}) {
  const r = express.Router();
  r.post(
    "/api/v1/kyc/webhook",
    express.raw({ type: "application/json", limit: "256kb", inflate: false }),
    async (req, res) => {
      if (!admin || !kycReady(env))
        return res.status(503).json({ error: "kyc_not_configured" });
      const alg = { HMAC_SHA256_HEX: "sha256", HMAC_SHA512_HEX: "sha512" }[
        req.get("x-payload-digest-alg")
      ];
      const provided = req.get("x-payload-digest") ?? "";
      if (!alg || !Buffer.isBuffer(req.body) || !/^[a-f0-9]+$/i.test(provided))
        return res.status(400).json({ error: "invalid_signature" });
      const digest = createHmac(alg, env.SUMSUB_WEBHOOK_SECRET)
        .update(req.body)
        .digest();
      const actual = Buffer.from(provided, "hex");
      if (actual.length !== digest.length || !timingSafeEqual(actual, digest))
        return res.status(400).json({ error: "invalid_signature" });
      let event;
      try {
        event = JSON.parse(req.body.toString("utf8"));
      } catch {
        return res.status(422).json({ error: "invalid_request" });
      }
      if (event.testMode === true || event.sandboxMode === true)
        return res.status(400).json({ error: "production_events_required" });
      const match = /^([a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(
        event.externalUserId ?? "",
      );
      if (
        !match ||
        !/^[a-f0-9]{24}$/.test(event.applicantId ?? "") ||
        match[1] !== env.RACING_TENANT_ID
      )
        return res.status(422).json({ error: "invalid_account_binding" });
      try {
        await refreshKyc(
          admin,
          env,
          match[1],
          match[2],
          event.applicantId,
          provider,
        );
        return res.json({ received: true });
      } catch {
        return res.status(503).json({ error: "verification_retry_required" });
      }
    },
  );
  return r;
}
