import express from "express";
import Stripe from "stripe";
import { callRpc } from "./settlement.js";
import { z } from "zod";
export function commerceReady(env) {
  return (
    env.COMMERCE_APPROVED === "true" &&
    (env.NODE_ENV === "production" ? /^sk_live_/ : /^sk_(live|test)_/).test(
      env.STRIPE_SECRET_KEY ?? "",
    ) &&
    /^whsec_/.test(env.STRIPE_WEBHOOK_SECRET ?? "") &&
    /^https:\/\//.test(env.APP_ORIGIN ?? "")
  );
}
export function createCommerceRouter({
  client,
  env = process.env,
  stripe = env.STRIPE_SECRET_KEY
    ? new Stripe(env.STRIPE_SECRET_KEY, {
        maxNetworkRetries: 2,
        timeout: 10000,
      })
    : null,
} = {}) {
  const router = express.Router();
  router.post(
    "/api/v1/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb", inflate: false }),
    async (req, res) => {
      if (!client || !stripe || !env.STRIPE_WEBHOOK_SECRET)
        return res.status(503).json({ error: "payments_not_configured" });
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          req.get("stripe-signature"),
          env.STRIPE_WEBHOOK_SECRET,
        );
      } catch {
        return res.status(400).json({ error: "invalid_signature" });
      }
      if (env.NODE_ENV === "production" && event.livemode !== true)
        return res.status(400).json({ error: "production_events_required" });
      try {
        if (
          [
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
          ].includes(event.type)
        ) {
          const s = await stripe.checkout.sessions.retrieve(
            event.data.object.id,
          );
          if (s.payment_status !== "paid")
            return res.json({
              received: true,
              fulfillment: "awaiting_payment",
            });
          const meta = z
            .object({ tenant_id: z.uuid(), order_id: z.uuid() })
            .passthrough()
            .parse(s.metadata);
          if (
            s.mode !== "payment" ||
            s.currency !== "usd" ||
            !Number.isSafeInteger(s.amount_total) ||
            typeof s.payment_intent !== "string"
          )
            throw new Error("invalid_paid_session");
          await callRpc(client, "fulfill_coin_purchase", {
            p_tenant_id: meta.tenant_id,
            p_order_id: meta.order_id,
            p_stripe_session: s.id,
            p_stripe_intent: s.payment_intent,
            p_stripe_event: event.id,
            p_amount_paid_cents: s.amount_total,
            p_currency: s.currency,
          });
        } else if (
          ["charge.refunded", "charge.dispute.created"].includes(event.type)
        ) {
          let intent = event.data.object.payment_intent;
          if (!intent && event.data.object.charge) {
            const c = await stripe.charges.retrieve(event.data.object.charge);
            intent = c.payment_intent;
          }
          if (typeof intent === "string")
            await callRpc(client, "sim_payment_review", {
              p_stripe_event: event.id,
              p_stripe_intent: intent,
              p_reason: event.type,
            });
        }
        return res.json({ received: true });
      } catch {
        return res.status(503).json({ error: "fulfillment_retry_required" });
      }
    },
  );
  return router;
}
export async function createCheckout(
  customer,
  tenant,
  { order_id, package_id },
  env = process.env,
  stripeClient,
) {
  if (!commerceReady(env)) throw new Error("commerce_not_activated");
  const o = await callRpc(customer, "sim_create_order", {
    p_tenant_id: tenant,
    p_order_id: order_id,
    p_package_id: package_id,
  });
  if (o.state !== "Created") throw new Error("order_already_processed");
  const stripe =
    stripeClient ??
    new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10000 });
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
  const s = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      client_reference_id: o.id,
      metadata: {
        tenant_id: tenant,
        order_id: o.id,
        user_id: o.user_id,
        package_id: o.package_id,
      },
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: o.amount_cents,
            product_data: {
              name: `${o.gc} Gold Coins`,
              description:
                o.sc === "0.000000"
                  ? "Social play utility coins"
                  : `Includes ${o.sc} promotional Sweeps Coins; eligibility and rules apply.`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: origin.origin + "/#wallet?checkout=complete",
      cancel_url: origin.origin + "/#wallet?checkout=cancelled",
    },
    { idempotencyKey: `checkout:${tenant}:${o.id}` },
  );
  if (!s.url || new URL(s.url).hostname !== "checkout.stripe.com")
    throw new Error("invalid_checkout_url");
  return { url: s.url, order_id: o.id };
}
