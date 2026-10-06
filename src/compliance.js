import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticate } from "./signature.js";
import { callRpc } from "./settlement.js";
export const ComplianceReceipt = z
  .object({
    receipt_id: z.uuid(),
    auth_user_id: z.uuid(),
    purpose: z.enum(["identity", "location", "risk"]),
    decision: z.enum(["approved", "denied", "review"]),
    reason: z.string().min(1).max(160),
    observed_at: z.iso.datetime({ offset: true }),
    valid_until: z.iso.datetime({ offset: true }),
    subject_key: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    age_threshold: z.number().int().min(18).max(100).nullable().default(null),
    territory: z
      .string()
      .regex(/^[A-Z]{2}-[A-Z0-9]{1,4}$/)
      .nullable()
      .default(null),
    proxy_detected: z.boolean(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.decision !== "approved") return;
    if (d.purpose === "identity" && (!d.subject_key || !d.age_threshold))
      ctx.addIssue({ code: "custom", message: "identity_evidence_required" });
    if (d.purpose === "location" && (!d.territory || d.proxy_detected))
      ctx.addIssue({ code: "custom", message: "location_evidence_required" });
  });
export function createComplianceRouter({
  client,
  complianceKeys = new Map(),
  reviewKeys = new Map(),
} = {}) {
  const router = express.Router();
  function signedRoute(path, schema, keys, name, map) {
    router.post(
      path,
      express.raw({ type: "application/json", limit: "32kb", inflate: false }),
      async (req, res) => {
        if (!client || !keys.size)
          return res
            .status(503)
            .json({ error: "compliance_provider_not_configured" });
        if (!req.is("application/json"))
          return res.status(415).json({ error: "application_json_required" });
        const identity = authenticate(
          req,
          keys,
          Math.floor(Date.now() / 1000),
          path,
        );
        if (!identity)
          return res.status(401).json({ error: "invalid_signature" });
        let data;
        try {
          data = schema.safeParse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(req.body),
            ),
          );
        } catch {
          return res.status(400).json({ error: "invalid_json" });
        }
        if (!data.success)
          return res.status(422).json({ error: "invalid_compliance_payload" });
        try {
          return res.json(
            await callRpc(client, name, {
              p_tenant_id: identity.tenantId,
              p_provider_id: identity.providerId,
              ...map(data.data),
              p_payload_sha256: createHash("sha256")
                .update(req.body)
                .digest("hex"),
            }),
          );
        } catch (e) {
          const status =
            { PT400: 400, PT403: 403, PT404: 404, PT409: 409, 23505: 409 }[
              e.code
            ] ?? 503;
          if (status === 503) res.set("Retry-After", "2");
          return res
            .status(status)
            .json({
              error:
                status === 503
                  ? "retry_same_receipt"
                  : "compliance_receipt_rejected",
            });
        }
      },
    );
  }
  signedRoute(
    "/api/v1/compliance/receipts",
    ComplianceReceipt,
    complianceKeys,
    "grid_record_compliance",
    (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => ["p_" + k, v])),
  );
  signedRoute(
    "/api/v1/compliance/reviews/resolve",
    z
      .object({ case_id: z.uuid(), reason: z.string().min(10).max(500) })
      .strict(),
    reviewKeys,
    "grid_resolve_review",
    (d) => ({ p_case_id: d.case_id, p_reason: d.reason }),
  );
  signedRoute(
    "/api/v1/compliance/programs/publish",
    z
      .object({
        change_id: z.uuid(),
        program_id: z.uuid(),
        version: z.string().min(1).max(80),
        title: z.string().min(1).max(160),
        sponsor: z.string().min(1).max(200),
        official_rules_url: z
          .url()
          .refine((v) => new URL(v).protocol === "https:"),
        rules_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        starts_at: z.iso.datetime({ offset: true }),
        ends_at: z.iso.datetime({ offset: true }),
        minimum_age: z.number().int().min(18).max(100),
        territories: z
          .array(z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,4}$/))
          .min(1)
          .max(100),
        free_sc: z.string().regex(/^\d{1,4}(?:\.\d{1,6})?$/),
        period_hours: z.number().int().min(1).max(720),
        entries_per_period: z.number().int().min(1).max(100),
        authorization_reference: z.string().min(10).max(500),
      })
      .strict(),
    reviewKeys,
    "grid_publish_program",
    (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => ["p_" + k, v])),
  );
  signedRoute(
    "/api/v1/compliance/programs/activate",
    z
      .object({
        change_id: z.uuid(),
        program_id: z.uuid(),
        enabled: z.boolean(),
        authorization_reference: z.string().min(10).max(500),
      })
      .strict(),
    reviewKeys,
    "grid_activate_program",
    (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => ["p_" + k, v])),
  );
  return router;
}
