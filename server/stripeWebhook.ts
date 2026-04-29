/**
 * Fastvid — Stripe Webhook Handler
 * Handles subscription lifecycle events to update user subscription status
 */
import type { Express, Request, Response } from "express";
import express from "express";
import Stripe from "stripe";
import { updateUserSubscription, getUserByStripeCustomerId } from "./db";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

export function registerStripeWebhook(app: Express) {
  // MUST use raw body for signature verification — register BEFORE express.json()
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const sig = req.headers["stripe-signature"];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      let event: Stripe.Event;

      try {
        if (!webhookSecret || !sig) {
          // No secret configured — parse raw body directly (dev mode)
          const body = req.body instanceof Buffer ? req.body.toString() : req.body;
          event = JSON.parse(body) as Stripe.Event;
        } else {
          event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        }
      } catch (err) {
        console.error("[Webhook] Signature verification failed:", err);
        res.status(400).send("Webhook signature verification failed");
        return;
      }

      // Handle test events
      if (event.id.startsWith("evt_test_")) {
        console.log("[Webhook] Test event detected, returning verification response");
        res.json({ verified: true });
        return;
      }

      console.log(`[Webhook] Event: ${event.type} | ID: ${event.id}`);

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;
            const userId = session.metadata?.user_id ? parseInt(session.metadata.user_id) : null;
            if (userId && session.subscription) {
              await updateUserSubscription(userId, {
                subscriptionStatus: "active",
                subscriptionStartDate: new Date(),
                stripeSubscriptionId: session.subscription as string,
                stripeCustomerId: session.customer as string,
              });
              console.log(`[Webhook] Activated subscription for user ${userId}`);
            }
            break;
          }

          case "customer.subscription.updated": {
            const sub = event.data.object as Stripe.Subscription;
            const customer = await getUserByStripeCustomerId(sub.customer as string);
            if (customer) {
              const isActive = sub.status === "active" || sub.status === "trialing";
              await updateUserSubscription(customer.id, {
                subscriptionStatus: isActive ? "active" : "inactive",
                stripeSubscriptionId: sub.id,
              });
              console.log(`[Webhook] Updated subscription for user ${customer.id}: ${sub.status}`);
            }
            break;
          }

          case "customer.subscription.deleted": {
            const sub = event.data.object as Stripe.Subscription;
            const customer = await getUserByStripeCustomerId(sub.customer as string);
            if (customer) {
              await updateUserSubscription(customer.id, {
                subscriptionStatus: "cancelled",
                stripeSubscriptionId: sub.id,
              });
              console.log(`[Webhook] Cancelled subscription for user ${customer.id}`);
            }
            break;
          }

          case "invoice.payment_failed": {
            const invoice = event.data.object as Stripe.Invoice;
            const customer = await getUserByStripeCustomerId(invoice.customer as string);
            if (customer) {
              await updateUserSubscription(customer.id, { subscriptionStatus: "inactive" });
              console.log(`[Webhook] Payment failed for user ${customer.id} — subscription deactivated`);
            }
            break;
          }

          default:
            console.log(`[Webhook] Unhandled event type: ${event.type}`);
        }
      } catch (err) {
        console.error("[Webhook] Error processing event:", err);
        res.status(500).send("Webhook processing error");
        return;
      }

      res.json({ received: true });
    }
  );
}
