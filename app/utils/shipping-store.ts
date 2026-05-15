import prisma from "../db.server";
import type { OrderEmailLog } from "@prisma/client";
import { buildTrackingUrl, isCarrier } from "./tracking";

// Thrown by markShippingReady() when the order isn't sendable yet.
// The action handler in route loaders catches this and returns the message
// to the UI as fetcher.data.error.
export class ShippingReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippingReadyError";
  }
}

export type OrderSnapshot = {
  shopifyOrderId: string;
  orderName: string;
  customerEmail: string;
  customerName: string;
  country: string;
  postalCode?: string | null;
  productsSummary: string;
  fulfillmentStatus: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
};

// Pulls Shopify snapshot into local DB without overwriting user-entered tracking.
export async function upsertOrderEmailLog(snap: OrderSnapshot): Promise<OrderEmailLog> {
  const existing = await prisma.orderEmailLog.findUnique({
    where: { shopifyOrderId: snap.shopifyOrderId },
  });

  if (existing) {
    return prisma.orderEmailLog.update({
      where: { id: existing.id },
      data: {
        orderName: snap.orderName,
        customerEmail: snap.customerEmail || existing.customerEmail,
        customerName: snap.customerName || existing.customerName,
        country: snap.country || existing.country,
        postalCode: snap.postalCode ?? existing.postalCode ?? null,
        productsSummary: snap.productsSummary || existing.productsSummary,
        fulfillmentStatus: snap.fulfillmentStatus,
        // Only fill carrier/tracking from Shopify if local has nothing.
        carrier: existing.carrier ?? snap.carrier ?? null,
        trackingNumber: existing.trackingNumber ?? snap.trackingNumber ?? null,
        trackingUrl: existing.trackingUrl ?? snap.trackingUrl ?? null,
      },
    });
  }

  return prisma.orderEmailLog.create({
    data: {
      shopifyOrderId: snap.shopifyOrderId,
      orderName: snap.orderName,
      customerEmail: snap.customerEmail,
      customerName: snap.customerName,
      country: snap.country,
      postalCode: snap.postalCode ?? null,
      productsSummary: snap.productsSummary,
      fulfillmentStatus: snap.fulfillmentStatus,
      carrier: snap.carrier ?? null,
      trackingNumber: snap.trackingNumber ?? null,
      trackingUrl: snap.trackingUrl ?? null,
    },
  });
}

export async function saveTracking(
  id: string,
  carrier: string | null,
  trackingNumber: string | null,
): Promise<OrderEmailLog> {
  const current = await prisma.orderEmailLog.findUniqueOrThrow({ where: { id } });
  let trackingUrl: string | null = null;
  if (carrier && trackingNumber && isCarrier(carrier)) {
    const url = buildTrackingUrl(carrier, trackingNumber, { postalCode: current.postalCode });
    trackingUrl = url || null;
  }
  return prisma.orderEmailLog.update({
    where: { id },
    data: { carrier, trackingNumber, trackingUrl },
  });
}

function nextStatusAfterReady(
  current: OrderEmailLog,
  side: "confirmation" | "shipping",
): string {
  const confReady = side === "confirmation" ? true : !!current.confirmationReadyAt;
  const shipReady = side === "shipping" ? true : !!current.shippingReadyAt;
  if (confReady && shipReady) return "ready_both";
  if (confReady) return "ready_confirmation";
  if (shipReady) return "ready_shipping";
  return "pending";
}

export async function markConfirmationReady(id: string): Promise<OrderEmailLog> {
  const current = await prisma.orderEmailLog.findUniqueOrThrow({ where: { id } });
  return prisma.orderEmailLog.update({
    where: { id },
    data: {
      confirmationReadyAt: new Date(),
      emailStatus: nextStatusAfterReady(current, "confirmation"),
    },
  });
}

async function rejectShipping(id: string, message: string): Promise<never> {
  await markEmailError(id, message);
  throw new ShippingReadyError(message);
}

export async function markShippingReady(id: string): Promise<OrderEmailLog> {
  const current = await prisma.orderEmailLog.findUniqueOrThrow({ where: { id } });
  if (!current.trackingNumber || !current.trackingNumber.trim()) {
    await rejectShipping(id, "Numéro de suivi manquant");
  }
  if (!current.carrier || !current.carrier.trim()) {
    await rejectShipping(id, "Transporteur manquant");
  }
  if (!current.trackingUrl || !current.trackingUrl.trim()) {
    await rejectShipping(id, "Lien de suivi manquant — transporteur non reconnu");
  }
  return prisma.orderEmailLog.update({
    where: { id },
    data: {
      shippingReadyAt: new Date(),
      emailStatus: nextStatusAfterReady(current, "shipping"),
    },
  });
}

export async function markEmailSent(
  id: string,
  side: "confirmation" | "shipping",
): Promise<OrderEmailLog> {
  const current = await prisma.orderEmailLog.findUniqueOrThrow({ where: { id } });
  const confSent = side === "confirmation" ? true : !!current.confirmationEmailSentAt;
  const shipSent = side === "shipping" ? true : !!current.shippingEmailSentAt;
  let emailStatus: string;
  if (confSent && shipSent) emailStatus = "sent_both";
  else if (confSent) emailStatus = "sent_confirmation";
  else emailStatus = "sent_shipping";

  const data =
    side === "confirmation"
      ? { confirmationEmailSentAt: new Date(), lastEmailError: null, emailStatus }
      : { shippingEmailSentAt: new Date(), lastEmailError: null, emailStatus };
  return prisma.orderEmailLog.update({ where: { id }, data });
}

export async function markEmailError(id: string, error: string): Promise<OrderEmailLog> {
  return prisma.orderEmailLog.update({
    where: { id },
    data: { lastEmailError: error, emailStatus: "error" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function validateEmailRecipient(log: OrderEmailLog): Promise<boolean> {
  if (!log.customerEmail || !EMAIL_RE.test(log.customerEmail)) {
    await markEmailError(log.id, "Email destinataire manquant");
    return false;
  }
  return true;
}

export async function clearEmailError(id: string): Promise<OrderEmailLog> {
  return prisma.orderEmailLog.update({
    where: { id },
    data: { lastEmailError: null },
  });
}

export async function resetEmailStatus(id: string): Promise<OrderEmailLog> {
  return prisma.orderEmailLog.update({
    where: { id },
    data: {
      confirmationReadyAt: null,
      shippingReadyAt: null,
      confirmationEmailSentAt: null,
      shippingEmailSentAt: null,
      emailStatus: "pending",
      lastEmailError: null,
    },
  });
}

export async function updateNotes(id: string, notes: string | null): Promise<OrderEmailLog> {
  return prisma.orderEmailLog.update({
    where: { id },
    data: { notes },
  });
}

export async function getOrderEmailLog(id: string): Promise<OrderEmailLog | null> {
  return prisma.orderEmailLog.findUnique({ where: { id } });
}

export async function listOrderEmailLogs(): Promise<OrderEmailLog[]> {
  return prisma.orderEmailLog.findMany({ orderBy: { createdAt: "desc" } });
}
