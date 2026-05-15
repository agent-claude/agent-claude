import prisma from "../db.server";
import type { OrderEmailLog } from "@prisma/client";
import { buildTrackingUrl, isCarrier } from "./tracking";

export type OrderSnapshot = {
  shopifyOrderId: string;
  orderName: string;
  customerEmail: string;
  customerName: string;
  country: string;
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
  let trackingUrl: string | null = null;
  if (carrier && trackingNumber && isCarrier(carrier)) {
    const url = buildTrackingUrl(carrier, trackingNumber);
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

export async function markShippingReady(id: string): Promise<OrderEmailLog> {
  const current = await prisma.orderEmailLog.findUniqueOrThrow({ where: { id } });
  return prisma.orderEmailLog.update({
    where: { id },
    data: {
      shippingReadyAt: new Date(),
      emailStatus: nextStatusAfterReady(current, "shipping"),
    },
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
