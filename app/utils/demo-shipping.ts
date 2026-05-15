import type { OrderSnapshot } from "./shipping-store";
import { buildTrackingUrl } from "./tracking";

export const DEMO_ORDER_PREFIX = "demo://";

export function isDemoModeForced(): boolean {
  return process.env.DEMO_SHIPPING === "true";
}

export function isDemoOrderId(shopifyOrderId: string | null | undefined): boolean {
  return typeof shopifyOrderId === "string" && shopifyOrderId.startsWith(DEMO_ORDER_PREFIX);
}

export function getDemoSnapshots(): OrderSnapshot[] {
  return [
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1001`,
      orderName: "#LAYA1001",
      customerName: "Camille Dubois",
      customerEmail: "camille.dubois@example.fr",
      country: "France",
      productsSummary: "1× Poudre d'ube 100g, 1× Cuillère doseuse",
      fulfillmentStatus: "UNFULFILLED",
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
    },
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1002`,
      orderName: "#LAYA1002",
      customerName: "Lucas Martin",
      customerEmail: "lucas.martin@example.fr",
      country: "France",
      productsSummary: "2× Poudre d'ube 100g, 1× Tote bag LAYA",
      fulfillmentStatus: "PARTIALLY_FULFILLED",
      carrier: "mondial_relay",
      trackingNumber: "6B12345678",
      trackingUrl: buildTrackingUrl("mondial_relay", "6B12345678", { postalCode: "75011" }),
    },
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1003`,
      orderName: "#LAYA1003",
      customerName: "Sophie Janssens",
      customerEmail: "sophie.janssens@example.be",
      country: "Belgique",
      productsSummary: "1× Poudre d'ube 100g, 1× Carte recettes",
      fulfillmentStatus: "PARTIALLY_FULFILLED",
      carrier: "mondial_relay",
      trackingNumber: "6B11223344",
      trackingUrl: buildTrackingUrl("mondial_relay", "6B11223344"),
    },
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1004`,
      orderName: "#LAYA1004",
      customerName: "Maximilian Schmidt",
      customerEmail: "max.schmidt@example.de",
      country: "Allemagne",
      productsSummary: "3× Poudre d'ube 100g",
      fulfillmentStatus: "FULFILLED",
      carrier: "mondial_relay",
      trackingNumber: "6B55667788",
      trackingUrl: buildTrackingUrl("mondial_relay", "6B55667788"),
    },
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1005`,
      orderName: "#LAYA1005",
      customerName: "Léa Müller",
      customerEmail: "lea.muller@example.ch",
      country: "Suisse",
      productsSummary: "1× Poudre d'ube 100g, 1× Cuillère doseuse, 1× Tote bag LAYA",
      fulfillmentStatus: "UNFULFILLED",
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
    },
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1006`,
      orderName: "#LAYA1006",
      customerName: "Carmen García",
      customerEmail: "carmen.garcia@example.es",
      country: "Espagne",
      productsSummary: "2× Poudre d'ube 100g, 1× Carte recettes",
      fulfillmentStatus: "PARTIALLY_FULFILLED",
      carrier: "mondial_relay",
      trackingNumber: "6B99887766",
      trackingUrl: buildTrackingUrl("mondial_relay", "6B99887766"),
    },
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1007`,
      orderName: "#LAYA1007",
      customerName: "João Silva",
      customerEmail: "joao.silva@example.pt",
      country: "Portugal",
      productsSummary: "1× Poudre d'ube 100g, 1× Cuillère doseuse",
      fulfillmentStatus: "UNFULFILLED",
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
    },
    {
      shopifyOrderId: `${DEMO_ORDER_PREFIX}order/1008`,
      orderName: "#LAYA1008",
      customerName: "Giulia Romano",
      customerEmail: "giulia.romano@example.it",
      country: "Italie",
      productsSummary: "2× Poudre d'ube 100g, 1× Tote bag LAYA",
      fulfillmentStatus: "PARTIALLY_FULFILLED",
      carrier: "mondial_relay",
      trackingNumber: "6B33445566",
      trackingUrl: buildTrackingUrl("mondial_relay", "6B33445566"),
    },
  ];
}
