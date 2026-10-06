import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { authenticate, SIGNING_PATH } from "./signature.js";
import { ProviderReport, commitProviderReport } from "./providers.js";
import { Telemetry, decide } from "./telemetry.js";
import { RpcError, settleCalculatedWinner, retryable } from "./settlement.js";
import { safeLogger } from "./logging.js";
import { readFileSync, existsSync } from "node:fs";
import { createCommerceRouter } from "./commerce.js";
import { createProviderRouter } from "./provider-routes.js";
import { createOAuthRouter, createSteamRouter } from "./oauth.js";
import { fileURLToPath } from "node:url";
import { createCustomerRouter } from "./customer.js";
import { sweep } from "./sweep.js";

const publicDirectory = fileURLToPath(
  new URL("../frontend/out/", import.meta.url),
);

export function createApp({
  client,
  keys = new Map(),
  log = (record) => console.log(JSON.stringify(record)),
  rpcOptions,
  customerOptions,
  cronSecret,
  env = process.env,
  brokerKeys = new Map(),
  stripe,
} = {}) {
  const writeLog = safeLogger(log);
  const configured = Boolean(client && keys.size);
  const app = express();
  const htmlPath = publicDirectory + "index.html";
  const hashes = existsSync(htmlPath)
    ? [
        ...readFileSync(htmlPath, "utf8").matchAll(
          /<script([^>]*)>([\s\S]*?)<\/script>/g,
        ),
      ]
        .filter((m) => !m[1].includes("src="))
        .map(
          (m) =>
            "'sha256-" +
            createHash("sha256").update(m[2]).digest("base64") +
            "'",
        )
    : [];
  const pageCSP =
    "default-src 'self'; script-src 'self' " +
    hashes.join(" ") +
    "; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.supabase.co; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set({
      "X-Request-Id": req.requestId,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/v1/operations/refund-expired", async (req, res) => {
    if (!client || typeof cronSecret !== "string" || cronSecret.length < 32)
      return res.status(503).json({ error: "refund_scheduler_not_configured" });
    const digest = (value) => createHash("sha256").update(value).digest();
    if (
      !timingSafeEqual(
        digest(req.get("authorization") || ""),
        digest(`Bearer ${cronSecret}`),
      )
    )
      return res.status(401).json({ error: "unauthorized" });
    try {
      // At most eleven 2-second calls. Every refund remains its own atomic,
      // idempotent transaction; another worker safely retries an interrupted batch.
      const result = await sweep(client, {
        limit: 10,
        rpcOptions: { attempts: 1, timeoutMs: 2000 },
        log: (record) => writeLog(JSON.parse(record)),
      });
      return res.status(result.failures ? 503 : 200).json(result);
    } catch {
      return res.status(503).json({ error: "refund_scheduler_retry_required" });
    }
  });
  app.get("/api/v1/status", (_req, res) =>
    res.json({
      service: "racing-escrow-engine",
      version: "3.0.0",
      settlement: configured ? "configured" : "configuration_required",
      database_connectivity: "unchecked",
    }),
  );
  app.use(createCommerceRouter({ client, env, stripe }));
  app.use(createProviderRouter({ client, keys, brokerKeys }));
  app.use(createOAuthRouter({ client, env }));
  app.use(createSteamRouter({ client, env }));
  app.use(
    express.static(publicDirectory, {
      dotfiles: "deny",
      redirect: false,
      etag: false,
      lastModified: false,
      setHeaders(res) {
        res.set("Content-Security-Policy", pageCSP);
      },
    }),
  );
  // Never register express.json() before this route: authenticate the EXACT bytes.
  app.post(
    SIGNING_PATH,
    (req, res, next) => {
      if (!configured) {
        res.set("Retry-After", "60");
        return res.status(503).json({ error: "service_not_configured" });
      }
      if (!req.is("application/json"))
        return res.status(415).json({ error: "application_json_required" });
      next();
    },
    express.raw({ type: "application/json", limit: "1mb", inflate: false }),
    async (req, res) => {
      const started = Date.now();
      const identity = authenticate(req, keys);
      if (!identity)
        return res.status(401).json({ error: "invalid_signature" });
      let decoded;
      try {
        // Fatal UTF-8 decode prevents silently accepting replacement characters.
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(req.body),
        );
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }
      if (decoded && typeof decoded.source_id === "string") {
        const parsed = ProviderReport.safeParse(decoded);
        if (!parsed.success)
          return res.status(422).json({ error: "invalid_provider_report" });
        try {
          return res.json(
            await commitProviderReport(
              client,
              identity,
              parsed.data,
              createHash("sha256").update(req.body).digest("hex"),
            ),
          );
        } catch (e) {
          return res
            .status(e.code === "PT403" ? 403 : e.code === "PT409" ? 409 : 503)
            .json({ error: "provider_result_rejected_or_retry_required" });
        }
      }
      const parsed = Telemetry.safeParse(decoded);
      if (!parsed.success)
        return res.status(422).json({ error: "invalid_telemetry" });
      const payload = parsed.data;
      const decision = decide(payload);
      const payloadSha256 = createHash("sha256").update(req.body).digest("hex");
      const context = {
        request_id: req.requestId,
        tenant_id: identity.tenantId,
        provider_id: identity.providerId,
        challenge_id: payload.challenge_id,
        event_id: payload.event_id,
      };
      try {
        const result = await settleCalculatedWinner(
          client,
          identity,
          payload,
          decision,
          payloadSha256,
          rpcOptions,
        );
        writeLog({
          ...context,
          outcome: result.resolution,
          duplicate: result.duplicate,
          duration_ms: Date.now() - started,
        });
        return res.status(200).json(result);
      } catch (cause) {
        const error =
          cause instanceof RpcError ? cause : new RpcError("NETWORK");
        writeLog({
          ...context,
          outcome: "rpc_error",
          code: error.code,
          duration_ms: Date.now() - started,
        });
        if (retryable(error)) {
          res.set("Retry-After", "2");
          return res
            .status(503)
            .json({ error: "retry_same_event", request_id: req.requestId });
        }
        const status =
          { PT400: 400, PT403: 403, PT404: 404, PT409: 409, 23505: 409 }[
            error.code
          ] ?? 500;
        return res.status(status).json({
          error: status === 500 ? "internal_error" : "event_rejected",
          request_id: req.requestId,
        });
      }
    },
  );
  const customerRouter = createCustomerRouter({
    env,
    admin: client,
    stripe,
    ...customerOptions,
  });
  app.use("/api/v1/stripe/create-checkout", (req, res, next) => {
    req.url = "/checkout";
    customerRouter(req, res, next);
  });
  app.use("/api/v1/app", customerRouter);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, req, res, _next) => {
    const status =
      error.type === "entity.too.large"
        ? 413
        : Number.isInteger(error.status) &&
            error.status >= 400 &&
            error.status < 500
          ? error.status
          : 500;
    writeLog({
      request_id: req.requestId,
      outcome: "request_rejected",
      status,
    });
    if (!res.headersSent) res.status(status).json({ error: "invalid_request" });
  });
  return app;
}
