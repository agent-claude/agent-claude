import type { OrderSnapshot } from "./shipping-store";
import { inferCarrierFromLabel } from "./tracking";

type GraphqlResponse = { json: () => Promise<unknown> };
type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<GraphqlResponse>;
};

const SHIPPING_ORDERS_QUERY = `
  query GetShippingOrders($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFulfillmentStatus
          customer { firstName lastName email }
          shippingAddress { country countryCodeV2 }
          lineItems(first: 20) {
            edges {
              node {
                title
                quantity
                variant { title }
              }
            }
          }
          fulfillments(first: 5) {
            trackingInfo { number url company }
          }
        }
      }
    }
  }
`;

type RawNode = {
  id: string;
  name: string;
  createdAt: string;
  displayFulfillmentStatus?: string | null;
  customer?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  shippingAddress?: { country?: string | null; countryCodeV2?: string | null } | null;
  lineItems?: {
    edges: {
      node: {
        title: string;
        quantity: number;
        variant?: { title?: string | null } | null;
      };
    }[];
  };
  fulfillments?: {
    trackingInfo?: { number?: string | null; url?: string | null; company?: string | null }[];
  }[];
};

function buildProductsSummary(node: RawNode): string {
  const edges = node.lineItems?.edges ?? [];
  return edges
    .map(({ node: li }) => {
      const variant = li.variant?.title;
      const variantSuffix = variant && variant !== "Default Title" ? ` (${variant})` : "";
      return `${li.quantity}× ${li.title}${variantSuffix}`;
    })
    .join(", ");
}

function pickFirstTracking(node: RawNode) {
  for (const f of node.fulfillments ?? []) {
    const info = f.trackingInfo?.[0];
    if (info && (info.number || info.url || info.company)) return info;
  }
  return null;
}

export async function fetchShippingOrders(admin: AdminClient, limit = 50): Promise<{
  snapshots: OrderSnapshot[];
  shopifyOrderIds: string[];
}> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const resp = await admin.graphql(SHIPPING_ORDERS_QUERY, { variables: { first: safeLimit } });
  const json = (await resp.json()) as {
    data?: { orders?: { edges: { node: RawNode }[] } };
    errors?: unknown;
  };

  const edges = json.data?.orders?.edges ?? [];
  const snapshots: OrderSnapshot[] = [];
  const shopifyOrderIds: string[] = [];

  for (const { node } of edges) {
    const customer = node.customer ?? {};
    const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim() || "—";
    const customerEmail = customer.email ?? "";
    const country = node.shippingAddress?.country ?? node.shippingAddress?.countryCodeV2 ?? "";
    const productsSummary = buildProductsSummary(node);

    const tracking = pickFirstTracking(node);
    const carrier = inferCarrierFromLabel(tracking?.company ?? null);

    snapshots.push({
      shopifyOrderId: node.id,
      orderName: node.name,
      customerEmail,
      customerName,
      country,
      productsSummary,
      fulfillmentStatus: node.displayFulfillmentStatus ?? "UNFULFILLED",
      carrier,
      trackingNumber: tracking?.number ?? null,
      trackingUrl: tracking?.url ?? null,
    });
    shopifyOrderIds.push(node.id);
  }

  return { snapshots, shopifyOrderIds };
}
