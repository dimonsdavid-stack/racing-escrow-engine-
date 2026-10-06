import express from "express";
import { createHash } from "node:crypto";
import { authenticate } from "./signature.js";
import {
  EventRegistration,
  ProviderReport,
  commitProviderReport,
} from "./providers.js";
import { callRpc } from "./settlement.js";
import { z } from "zod";
export function createProviderRouter({
  client,
  keys = new Map(),
  brokerKeys = new Map(),
} = {}) {
  const r = express.Router();
  function route(path, schema, handler, keyring = keys) {
    r.post(
      path,
      express.raw({ type: "application/json", limit: "2mb", inflate: false }),
      async (req, res) => {
        if (!client || !keyring.size)
          return res.status(503).json({ error: "provider_not_activated" });
        const identity = authenticate(
          req,
          keyring,
          Math.floor(Date.now() / 1000),
          path,
        );
        if (!identity)
          return res.status(401).json({ error: "invalid_signature" });
        try {
          const parsed = schema.safeParse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(req.body),
            ),
          );
          if (!parsed.success)
            return res.status(422).json({ error: "invalid_provider_payload" });
          return res.json(
            await handler(
              identity,
              parsed.data,
              createHash("sha256").update(req.body).digest("hex"),
            ),
          );
        } catch (e) {
          return res
            .status(e.code === "PT403" ? 403 : e.code === "PT409" ? 409 : 503)
            .json({ error: "provider_request_rejected_or_retry_required" });
        }
      },
    );
  }
  route(
    "/api/v1/providers/contracts",
    z
      .object({
        external_session_id: z.string().min(1).max(100),
        after: z.uuid().nullable().optional(),
      })
      .strict(),
    (i, d) =>
      callRpc(client, "sim_provider_contracts", {
        p_tenant_id: i.tenantId,
        p_provider_id: i.providerId,
        p_external_session_id: d.external_session_id,
        p_after: d.after ?? null,
      }),
  );
  route("/api/v1/providers/events", EventRegistration, async (i, d) =>
    callRpc(client, "grid_register_event", {
      p_tenant_id: i.tenantId,
      p_provider_id: i.providerId,
      ...Object.fromEntries(Object.entries(d).map(([k, v]) => ["p_" + k, v])),
    }),
  );
  route("/api/v1/providers/results", ProviderReport, (i, d, h) =>
    commitProviderReport(client, i, d, h),
  );
  route(
    "/api/v1/challenges/initiate",
    z
      .object({
        actor_discord_id: z.string().regex(/^\d{17,20}$/),
        opponent_discord_id: z.string().regex(/^\d{17,20}$/),
        request_id: z.uuid(),
        event_id: z.uuid(),
        token_type: z.enum(["GC", "SC"]),
        entry_fee: z.string().regex(/^\d{1,4}(?:\.\d{1,2})?$/),
      })
      .strict(),
    (i, d) =>
      callRpc(client, "sim_discord_offer", {
        p_tenant_id: i.tenantId,
        p_actor_discord: d.actor_discord_id,
        p_opponent_discord: d.opponent_discord_id,
        p_request_id: d.request_id,
        p_event_id: d.event_id,
        p_token_type: d.token_type,
        p_entry_fee: d.entry_fee,
      }),
    brokerKeys,
  );
  route(
    "/api/v1/challenges/accept",
    z
      .object({
        actor_discord_id: z.string().regex(/^\d{17,20}$/),
        offer_id: z.uuid(),
      })
      .strict(),
    (i, d) =>
      callRpc(client, "sim_discord_accept", {
        p_tenant_id: i.tenantId,
        p_actor_discord: d.actor_discord_id,
        p_offer_id: d.offer_id,
      }),
    brokerKeys,
  );
  return r;
}
