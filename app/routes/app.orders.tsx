import { useState } from "react";
import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseUgcProduit, coutComps, ugcShippingCost, compsToKey, PRODUIT_LABELS } from "../utils/ugc";

// ─── Types ────────────────────────────────────────────────────────────────────

type LineItem = {
  title: string;
  variantTitle: string | null;
  quantity: number;
  unitPrice: number;
  sku: string | null;
};

type Order = {
  id: string;
  name: string;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  countryCode: string;
  country: string;
  totalPrice: number;
  subtotalPrice: number;
  shippingPrice: number;
  discountTotal: number;
  refundedTotal: number;
  paymentGateway: string;
  lineItems: LineItem[];
  fulfillmentStatus: string;
  financialStatus: string;
  cancelledAt: string | null;
  closed: boolean;
  test: boolean;
  source: "shopify" | "manuel";
  cogs: number;
  cogsMain: number;
  cogsGift: number;
  giftLabel: string;
  soldLabel: string;
  productKey: string;
  realShipping: number;
  paymentFees: number;
  netPrice: number;
  margin: number;
};

type DbExpense = {
  id: string;
  date: string;
  category: string;
  label: string;
  amount: number;
  note: string | null;
};

// ─── Helpers produit / livraison ──────────────────────────────────────────────

function orderCogs(items: LineItem[]): number {
  return items.reduce((s, item) => {
    const comps = parseUgcProduit(`${item.title} ${item.variantTitle ?? ""}`);
    return s + coutComps(comps) * item.quantity;
  }, 0);
}

function orderRealShipping(countryCode: string, items: LineItem[]): number {
  const total = { pots: 0, fouets: 0, bols: 0, cuilleres: 0 };
  for (const item of items) {
    const c = parseUgcProduit(`${item.title} ${item.variantTitle ?? ""}`);
    total.pots      += c.pots      * item.quantity;
    total.fouets    += c.fouets    * item.quantity;
    total.bols      += c.bols      * item.quantity;
    total.cuilleres += c.cuilleres * item.quantity;
  }
  return ugcShippingCost(countryCode || "FR", total);
}

function orderCogsMain(items: LineItem[]): number {
  return orderCogs(items.filter((li) => li.unitPrice > 0.005));
}

function orderCogsGift(items: LineItem[]): number {
  return orderCogs(items.filter((li) => li.unitPrice <= 0.005));
}

function orderGiftLabel(items: LineItem[]): string {
  return items
    .filter((li) => li.unitPrice <= 0.005)
    .map((li) => `${li.quantity > 1 ? `${li.quantity}× ` : ""}${li.title}`)
    .join(", ");
}

function orderProductKey(items: LineItem[]): string {
  const sold = items.filter((li) => li.unitPrice > 0.005);
  const total = { pots: 0, fouets: 0, bols: 0, cuilleres: 0 };
  for (const item of sold) {
    const c = parseUgcProduit(`${item.title} ${item.variantTitle ?? ""}`);
    total.pots      += c.pots      * item.quantity;
    total.fouets    += c.fouets    * item.quantity;
    total.bols      += c.bols      * item.quantity;
    total.cuilleres += c.cuilleres * item.quantity;
  }
  return compsToKey(total) || "autre";
}

function orderSoldLabel(items: LineItem[]): string {
  const sold = items.filter((li) => li.unitPrice > 0.005);
  if (sold.length === 0) return "—";
  return sold.map((li) => `${li.quantity > 1 ? `${li.quantity}× ` : ""}${li.title}`).join(", ");
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

// Pas de filtre "query:" — status:any n'est pas valide en GQL et tronque les résultats
const ORDERS_QUERY = `
  query GetOrders($cursor: String) {
    orders(first: 250, after: $cursor, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          cancelledAt
          closed
          test
          customer { firstName lastName email }
          shippingAddress { country countryCodeV2 }
          totalPriceSet            { shopMoney { amount } }
          currentTotalPriceSet     { shopMoney { amount } }
          currentSubtotalPriceSet  { shopMoney { amount } }
          totalShippingPriceSet    { shopMoney { amount } }
          currentTotalDiscountsSet { shopMoney { amount } }
          paymentGatewayNames
          lineItems(first: 20) {
            edges {
              node {
                title
                quantity
                originalUnitPriceSet { shopMoney { amount } }
                variant { sku title }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllOrders(admin: any): Promise<Order[]> {
  const all: Order[] = [];
  let cursor: string | null = null;
  let hasNext = true;
  let pages = 0;

  while (hasNext && pages < 20) {
    const resp = await admin.graphql(ORDERS_QUERY, { variables: { cursor } });
    const json = await resp.json() as {
      data?: { orders?: { edges: { node: unknown }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      errors?: unknown;
    };

    const page = json.data?.orders;
    if (!page) break;

    for (const { node } of page.edges) {
      const n = node as Record<string, unknown>;
      const lineItems: LineItem[] = (n.lineItems as { edges: { node: unknown }[] }).edges.map(({ node: li }) => {
        const l = li as Record<string, unknown>;
        const variant = l.variant as Record<string, string> | null;
        return {
          title: String(l.title ?? ""),
          variantTitle: variant?.title ?? null,
          quantity: Number(l.quantity ?? 1),
          unitPrice: parseFloat(((l.originalUnitPriceSet as { shopMoney: { amount: string } })?.shopMoney?.amount) ?? "0"),
          sku: variant?.sku ?? null,
        };
      });

      type MoneySet = { shopMoney: { amount: string } };
      const money = (field: unknown) => parseFloat(((field as MoneySet)?.shopMoney?.amount) ?? "0");

      const totalPrice    = money(n.totalPriceSet);
      const currentTotal  = money(n.currentTotalPriceSet);
      const subtotalPrice = money(n.currentSubtotalPriceSet);
      const shippingPrice = money(n.totalShippingPriceSet);
      const discountTotal = money(n.currentTotalDiscountsSet);
      const refundedTotal = Math.max(0, totalPrice - currentTotal);

      const customer    = n.customer as { firstName?: string; lastName?: string; email?: string } | null;
      const addr        = n.shippingAddress as { country?: string; countryCodeV2?: string } | null;
      const countryCode = addr?.countryCodeV2 ?? "FR";

      const cogs         = orderCogs(lineItems);
      const cogsMain     = orderCogsMain(lineItems);
      const cogsGift     = orderCogsGift(lineItems);
      const giftLabel    = orderGiftLabel(lineItems);
      const soldLabel    = orderSoldLabel(lineItems);
      const productKey   = orderProductKey(lineItems);
      const realShipping = orderRealShipping(countryCode, lineItems);
      const netPrice     = currentTotal;
      const paymentFees  = netPrice * 0.015;
      const margin       = netPrice - cogs - realShipping - paymentFees;

      all.push({
        id: String(n.id),
        name: String(n.name ?? ""),
        createdAt: String(n.createdAt ?? ""),
        customerName: customer ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Invité" : "Invité",
        customerEmail: customer?.email ?? "",
        countryCode,
        country: addr?.country ?? "",
        totalPrice,
        subtotalPrice,
        shippingPrice,
        discountTotal,
        refundedTotal,
        paymentGateway: ((n.paymentGatewayNames as string[]) ?? [])[0] ?? "",
        lineItems,
        fulfillmentStatus: String(n.displayFulfillmentStatus ?? ""),
        financialStatus:   String(n.displayFinancialStatus   ?? ""),
        cancelledAt:  n.cancelledAt ? String(n.cancelledAt) : null,
        closed:       Boolean(n.closed),
        test:         Boolean(n.test),
        source:       "shopify",
        cogs,
        cogsMain,
        cogsGift,
        giftLabel,
        soldLabel,
        productKey,
        realShipping,
        paymentFees,
        netPrice,
        margin,
      });
    }

    hasNext = page.pageInfo.hasNextPage;
    cursor  = page.pageInfo.endCursor ?? null;
    pages++;
  }

  return all;
}

// ─── REST Admin API (fallback complet) ───────────────────────────────────────

type RestLineItem = {
  title: string;
  quantity: number;
  price: string;
  variant_title: string | null;
  sku: string | null;
};

type RestOrder = {
  id: number;
  name: string;
  order_number: number;
  created_at: string;
  financial_status: string;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  closed_at: string | null;
  test: boolean;
  total_price: string;
  current_total_price: string;
  subtotal_price: string;
  total_discounts: string;
  total_shipping_price_set?: { shop_money?: { amount: string } };
  payment_gateway: string | null;
  customer?: { first_name?: string; last_name?: string; email?: string } | null;
  shipping_address?: { country?: string; country_code?: string } | null;
  line_items: RestLineItem[];
};

function parseRestOrder(o: RestOrder): Order {
  const lineItems: LineItem[] = o.line_items.map((li) => ({
    title: li.title,
    variantTitle: li.variant_title,
    quantity: li.quantity,
    unitPrice: parseFloat(li.price),
    sku: li.sku,
  }));

  const totalPrice    = parseFloat(o.total_price   ?? "0");
  const netPrice      = parseFloat(o.current_total_price ?? o.total_price ?? "0");
  const subtotalPrice = parseFloat(o.subtotal_price ?? "0");
  const shippingPrice = parseFloat(o.total_shipping_price_set?.shop_money?.amount ?? "0");
  const discountTotal = parseFloat(o.total_discounts ?? "0");
  const refundedTotal = Math.max(0, totalPrice - netPrice);
  const countryCode   = o.shipping_address?.country_code ?? "FR";

  const cogs         = orderCogs(lineItems);
  const cogsMain     = orderCogsMain(lineItems);
  const cogsGift     = orderCogsGift(lineItems);
  const giftLabel    = orderGiftLabel(lineItems);
  const soldLabel    = orderSoldLabel(lineItems);
  const productKey   = orderProductKey(lineItems);
  const realShipping = orderRealShipping(countryCode, lineItems);
  const paymentFees  = netPrice * 0.015;
  const margin       = netPrice - cogs - realShipping - paymentFees;

  return {
    id:            String(o.id),
    name:          o.name,
    createdAt:     o.created_at,
    customerName:  o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() || "Invité" : "Invité",
    customerEmail: o.customer?.email ?? "",
    countryCode,
    country:       o.shipping_address?.country ?? "",
    totalPrice,
    subtotalPrice,
    shippingPrice,
    discountTotal,
    refundedTotal,
    paymentGateway: o.payment_gateway ?? "",
    lineItems,
    fulfillmentStatus: (o.fulfillment_status ?? "UNFULFILLED").toUpperCase(),
    financialStatus:   (o.financial_status  ?? "").toUpperCase(),
    cancelledAt:  o.cancelled_at,
    closed:       !!o.closed_at,
    test:         o.test ?? false,
    source:       "shopify" as const,
    cogs,
    cogsMain,
    cogsGift,
    giftLabel,
    soldLabel,
    productKey,
    realShipping,
    paymentFees,
    netPrice,
    margin,
  };
}

async function fetchOrdersREST(session: { shop: string; accessToken: string }): Promise<Order[]> {
  const all: Order[] = [];
  // status=any inclut open + cancelled + archived; order=id+asc pour cohérence
  let url: string | null =
    `https://${session.shop}/admin/api/2026-07/orders.json?status=any&limit=250&order=id+asc`;
  let page = 1;

  while (url && page <= 20) {
    const currentUrl: string = url;
    const resp: Response = await fetch(currentUrl, {
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) break;

    const json = await resp.json() as { orders?: RestOrder[] };
    const raw  = json.orders ?? [];

    for (const o of raw) all.push(parseRestOrder(o));

    // Pagination via Link header
    const link: string              = resp.headers.get("Link") ?? "";
    const nextMatch: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    page++;
  }

  return all;
}

// ─── Commandes manuelles (non remontées par l'API Shopify) ───────────────────

function buildManualOrder(
  id: string,
  name: string,
  createdAt: string,
  customerName: string,
  netPrice: number,
  countryCode: string,
  lineItems: LineItem[],
): Order {
  const cogs         = orderCogs(lineItems);
  const cogsMain     = orderCogsMain(lineItems);
  const cogsGift     = orderCogsGift(lineItems);
  const giftLabel    = orderGiftLabel(lineItems);
  const soldLabel    = orderSoldLabel(lineItems);
  const productKey   = orderProductKey(lineItems);
  const realShipping = orderRealShipping(countryCode, lineItems);
  const paymentFees  = netPrice * 0.015;
  const margin       = netPrice - cogs - realShipping - paymentFees;
  return {
    id,
    name,
    createdAt,
    customerName,
    customerEmail: "",
    countryCode,
    country: countryCode === "FR" ? "France" : countryCode,
    totalPrice:   netPrice,
    subtotalPrice: netPrice,
    shippingPrice: 0,
    discountTotal: 0,
    refundedTotal: 0,
    paymentGateway: "",
    lineItems,
    fulfillmentStatus: "FULFILLED",
    financialStatus: "PAID",
    cancelledAt: null,
    closed: false,
    test: false,
    source: "manuel",
    cogs,
    cogsMain,
    cogsGift,
    giftLabel,
    soldLabel,
    productKey,
    realShipping,
    paymentFees,
    netPrice,
    margin,
  };
}

// Règles bundle Laya :
//   69,90 € → 3 pots + bol offert  (kit = {pots:3, bols:1})
//   28,90 € → 1 pot + cuillère offerte
// Titres choisis pour que parseUgcProduit détecte correctement les composants
// ("Bol" seul, sans "laya", pour éviter la détection parasite d'un pot)
const MANUAL_ORDERS: Order[] = [
  buildManualOrder("manual-1001", "#1001", "2026-03-02T12:00:00.000Z", "Samir Aouina",    69.90, "FR", [
    { title: "3 pots",   variantTitle: null, quantity: 1, unitPrice: 69.90, sku: null },
    { title: "Bol",      variantTitle: null, quantity: 1, unitPrice: 0,     sku: null },
  ]),
  buildManualOrder("manual-1002", "#1002", "2026-03-04T12:00:00.000Z", "Imane",           69.90, "FR", [
    { title: "3 pots",   variantTitle: null, quantity: 1, unitPrice: 69.90, sku: null },
    { title: "Bol",      variantTitle: null, quantity: 1, unitPrice: 0,     sku: null },
  ]),
  buildManualOrder("manual-1003", "#1003", "2026-03-07T12:00:00.000Z", "Julie Galissard", 28.90, "FR", [
    { title: "1 pot",    variantTitle: null, quantity: 1, unitPrice: 28.90, sku: null },
    { title: "Cuillère", variantTitle: null, quantity: 1, unitPrice: 0,     sku: null },
  ]),
];

function mergeManualOrders(shopifyOrders: Order[]): Order[] {
  const existingNames = new Set(shopifyOrders.map((o) => o.name));
  const toAdd = MANUAL_ORDERS.filter((m) => !existingNames.has(m.name));
  if (toAdd.length === 0) return shopifyOrders;
  const merged = [...shopifyOrders, ...toAdd];
  return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { admin, session } = await authenticate.admin(request) as any;
  const sess = session as { shop: string; accessToken: string };

  let orders: Order[] = [];
  let fetchError: string | null = null;

  // 1. REST primary (status=any)
  try {
    orders = await fetchOrdersREST(sess);
  } catch (e) {
    // Fallback GraphQL
    try {
      orders = await fetchAllOrders(admin);
    } catch (e2) {
      fetchError = String(e2);
    }
  }

  // 2. Merge manual orders (deduplicated by name)
  orders = mergeManualOrders(orders);

  const [rawExpenses, creators] = await Promise.all([
    prisma.expense.findMany({ orderBy: { date: "desc" } }),
    prisma.creator.findMany({
      where: { shippingStatus: { not: "refuse" } },
      select: { coutProduit: true, fraisPort: true, coutTotalCollab: true },
    }),
  ]);

  const expenses: DbExpense[] = rawExpenses.map((e) => ({
    id: e.id,
    date: e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date).slice(0, 10),
    category: e.category,
    label: e.label,
    amount: e.amount,
    note: e.note ?? null,
  }));

  const ugcStats = {
    cogs:     creators.reduce((s, c) => s + (c.coutProduit ?? 0), 0),
    shipping: creators.reduce((s, c) => s + c.fraisPort, 0),
    total:    creators.reduce((s, c) => s + (c.coutTotalCollab ?? 0), 0),
  };

  return { orders, expenses, ugcStats, fetchError };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "").trim();

  if (intent === "create_expense") {
    const label    = String(form.get("label")    ?? "").trim();
    const category = String(form.get("category") ?? "").trim();
    const amount   = parseFloat(String(form.get("amount") ?? "0").replace(",", "."));
    const dateStr  = String(form.get("date")     ?? "").trim();
    const note     = String(form.get("note")     ?? "").trim() || null;

    if (label && category && Number.isFinite(amount) && amount > 0 && dateStr) {
      await prisma.expense.create({
        data: { label, category, amount, date: new Date(dateStr), type: "charge", note, caGenere: 0 },
      });
    }
    return null;
  }

  if (intent === "delete_expense") {
    const id = String(form.get("id") ?? "").trim();
    if (id) await prisma.expense.delete({ where: { id } });
    return null;
  }

  return null;
};

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg:       "#F9F7F4",
  card:     "#FFFFFF",
  border:   "#EDE9E3",
  text:     "#1C1917",
  muted:    "#78716C",
  dim:      "#A8A29E",
  accent:   "#7C6FF7",
  accentBg: "#EEECFF",
  green:    "#16A34A",
  greenBg:  "#F0FDF4",
  greenBdr: "#86EFAC",
  amber:    "#92400E",
  amberBg:  "#FFFBEB",
  amberBdr: "#FDE68A",
  red:      "#DC2626",
  redBg:    "#FEF2F2",
  redBdr:   "#FECACA",
  font:     '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  shadow:   "0 1px 3px rgba(28,25,23,0.07)",
};

const inp: React.CSSProperties = {
  border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px",
  fontSize: 13, width: "100%", boxSizing: "border-box",
  background: "#fff", color: T.text, outline: "none",
};

// ─── Labels ───────────────────────────────────────────────────────────────────

const FINANCIAL_LABELS: Record<string, string> = {
  AUTHORIZED: "Autorisé", EXPIRED: "Expiré", PAID: "Payé",
  PARTIALLY_PAID: "Part. payé", PARTIALLY_REFUNDED: "Part. remb.",
  PENDING: "En attente", REFUNDED: "Remboursé", VOIDED: "Annulé",
};

const FULFILLMENT_LABELS: Record<string, string> = {
  FULFILLED: "Expédié", IN_PROGRESS: "En cours", ON_HOLD: "En attente",
  OPEN: "Ouvert", PARTIALLY_FULFILLED: "Part. expédié",
  PENDING_FULFILLMENT: "À expédier", RESTOCKED: "Restock",
  SCHEDULED: "Planifié", UNFULFILLED: "Non expédié",
};

const COUNTRY_LABELS: Record<string, string> = {
  FR: "France", BE: "Belgique", DE: "Allemagne", CH: "Suisse",
  IT: "Italie", PT: "Portugal", ES: "Espagne", NL: "Pays-Bas",
  GB: "Royaume-Uni", US: "États-Unis", CA: "Canada",
};

const EXPENSE_CATEGORIES = [
  "Meta Ads", "Shopify abonnement", "Cartons", "Flyers", "Design",
  "Événements", "UGC envoyés", "Livraison réelle", "Frais paiement", "Autres",
];

// ─── Badge components ─────────────────────────────────────────────────────────

function FinancialBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    PAID:               ["#F0FDF4", "#16A34A"],
    PARTIALLY_REFUNDED: ["#FEF2F2", "#DC2626"],
    REFUNDED:           ["#FEF2F2", "#DC2626"],
    PENDING:            [T.amberBg, T.amber],
    VOIDED:             ["#F1F5F9", "#64748B"],
  };
  const [bg, color] = map[status] ?? ["#F1F5F9", T.muted];
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 99, background: bg, color, whiteSpace: "nowrap" }}>
      {FINANCIAL_LABELS[status] ?? status}
    </span>
  );
}

function FulfillmentBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    FULFILLED:           ["#F0FDF4", "#16A34A"],
    PARTIALLY_FULFILLED: [T.accentBg, T.accent],
    UNFULFILLED:         [T.amberBg, T.amber],
    OPEN:                [T.amberBg, T.amber],
  };
  const [bg, color] = map[status] ?? ["#F1F5F9", T.muted];
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 99, background: bg, color, whiteSpace: "nowrap" }}>
      {FULFILLMENT_LABELS[status] ?? (status || "—")}
    </span>
  );
}

const eur = (n: number) => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });
const pct = (n: number) => `${n.toFixed(1)} %`;

// ─── Period helper ────────────────────────────────────────────────────────────

function periodCutoff(period: string): Date | null {
  if (period === "tout") return null;
  const days: Record<string, number> = { "7j": 7, "30j": 30, "90j": 90, "6m": 180, "12m": 365 };
  const d = new Date();
  d.setDate(d.getDate() - (days[period] ?? 30));
  return d;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const { orders, expenses, ugcStats, fetchError } = useLoaderData<typeof loader>();
  const expenseFetcher = useFetcher();

  const [search, setSearch]       = useState("");
  const [period, setPeriod]       = useState("tout");
  const [country, setCountry]     = useState("");
  const [finStatus, setFinStatus] = useState("");
  const [fulStatus, setFulStatus] = useState("");
  const [showAll, setShowAll]     = useState(false);

  const cutoff = periodCutoff(period);

  const filtered = orders.filter((o) => {
    if (cutoff && new Date(o.createdAt) < cutoff) return false;
    if (country   && o.countryCode       !== country)   return false;
    if (finStatus && o.financialStatus   !== finStatus) return false;
    if (fulStatus && o.fulfillmentStatus !== fulStatus) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!o.name.toLowerCase().includes(q) && !o.customerName.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const filteredExpenses = expenses.filter((e) => !cutoff || new Date(e.date) >= cutoff);

  // KPIs
  const caBrut         = filtered.reduce((s, o) => s + o.totalPrice, 0);
  const remboursements = filtered.reduce((s, o) => s + o.refundedTotal, 0);
  const caNet          = filtered.reduce((s, o) => s + o.netPrice, 0);
  const totalCogs      = filtered.reduce((s, o) => s + o.cogs, 0);
  const totalShipping  = filtered.reduce((s, o) => s + o.realShipping, 0);
  const totalPayFees   = filtered.reduce((s, o) => s + o.paymentFees, 0);
  const totalManualExp = filteredExpenses.reduce((s, e) => s + e.amount, 0);
  const totalCharges   = totalCogs + totalShipping + totalPayFees + totalManualExp;
  const benefice       = caNet - totalCharges;
  const margeNette     = caNet > 0 ? (benefice / caNet) * 100 : 0;
  const panierMoyen    = filtered.length > 0 ? caNet / filtered.length : 0;
  const nbClientes     = new Set(filtered.map((o) => o.customerEmail).filter(Boolean)).size;

  // Unique filter options
  const countries   = [...new Set(orders.map((o) => o.countryCode).filter(Boolean))].sort();
  const finStatuses = [...new Set(orders.map((o) => o.financialStatus).filter(Boolean))].sort();
  const fulStatuses = [...new Set(orders.map((o) => o.fulfillmentStatus).filter(Boolean))].sort();

  // Expense groups for display
  const expenseByCategory = filteredExpenses.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + e.amount;
    return acc;
  }, {});

  const displayOrders = showAll ? filtered : filtered.slice(0, 50);

  const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
  const lbT: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" };
  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: T.shadow };
  const th: React.CSSProperties = { padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: T.dim, borderBottom: `1px solid ${T.border}`, background: T.bg, whiteSpace: "nowrap" };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "28px 20px 80px", fontFamily: T.font, boxSizing: "border-box" }}>
      <div style={{ maxWidth: 1300, margin: "0 auto" }}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: T.text, letterSpacing: "-0.02em" }}>
              Commandes & Rentabilité
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: T.muted }}>
              {orders.length} commandes · {filtered.length} affichées
              {filtered.length !== orders.length && ` · ${orders.length - filtered.length} filtrées`}
            </p>
          </div>
          <a href="/app" style={{ fontSize: 12, color: T.muted, textDecoration: "none", padding: "7px 14px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.card, fontWeight: 500 }}>
            ← Dashboard
          </a>
        </div>

        {fetchError && (
          <div style={{ background: T.redBg, border: `1px solid ${T.redBdr}`, borderRadius: 12, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: T.red }}>
            <strong>Erreur Shopify :</strong> {fetchError}
          </div>
        )}

        {/* ── Filters ──────────────────────────────────────────────────────── */}
        <div style={{ ...card, padding: "12px 16px", marginBottom: 24, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: T.bg, borderRadius: 9, padding: 3, border: `1px solid ${T.border}` }}>
            {(["7j", "30j", "90j", "6m", "12m", "tout"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                style={{
                  padding: "5px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: "none",
                  fontWeight: period === p ? 600 : 400,
                  background: period === p ? T.card : "transparent",
                  color: period === p ? T.text : T.muted,
                  boxShadow: period === p ? "0 1px 2px rgba(28,25,23,0.09)" : "none",
                  fontFamily: T.font,
                }}
              >{p === "tout" ? "Tout" : p}</button>
            ))}
          </div>
          {([
            { value: country,   setter: setCountry,   ph: "Pays",      opts: countries.map((c) => ({ v: c, l: COUNTRY_LABELS[c] ?? c })) },
            { value: finStatus, setter: setFinStatus, ph: "Paiement",  opts: finStatuses.map((s) => ({ v: s, l: FINANCIAL_LABELS[s] ?? s })) },
            { value: fulStatus, setter: setFulStatus, ph: "Livraison", opts: fulStatuses.map((s) => ({ v: s, l: FULFILLMENT_LABELS[s] ?? s })) },
          ] as const).map(({ value, setter, ph, opts }) => (
            <select key={ph} value={value} onChange={(e) => setter(e.target.value)}
              style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 12, background: T.card, color: value ? T.text : T.muted, cursor: "pointer", outline: "none", fontFamily: T.font }}
            >
              <option value="">{ph}</option>
              {opts.map(({ v, l }) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
          <div style={{ marginLeft: "auto", position: "relative" }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.dim, fontSize: 14, pointerEvents: "none" }}>⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher…"
              style={{ ...inp, width: 170, padding: "6px 10px 6px 28px" }} />
          </div>
        </div>

        {/* ── KPI Row 1 ────────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 12 }}>
          <div style={{ ...card, padding: "20px 22px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, marginBottom: 12 }}>Commandes</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: T.text, letterSpacing: "-0.03em", lineHeight: 1 }}>{filtered.length}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 10 }}>{nbClientes} clientes · {eur(panierMoyen)}</div>
          </div>
          <div style={{ ...card, padding: "20px 22px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, marginBottom: 12 }}>CA brut</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: T.text, letterSpacing: "-0.02em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{eur(caBrut)}</div>
            {remboursements > 0 && <div style={{ fontSize: 11, color: T.red, marginTop: 10 }}>−{eur(remboursements)} remb.</div>}
          </div>
          <div style={{ ...card, padding: "20px 22px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, marginBottom: 12 }}>CA net</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: T.accent, letterSpacing: "-0.02em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{eur(caNet)}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 10 }}>après remb.</div>
          </div>
          <div style={{ ...card, padding: "20px 22px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, marginBottom: 12 }}>Charges</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: T.red, letterSpacing: "-0.02em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{eur(totalCharges)}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 10 }}>COGS + port + frais</div>
          </div>
          <div style={{ ...card, padding: "20px 22px", background: benefice >= 0 ? T.greenBg : T.redBg, border: `1px solid ${benefice >= 0 ? T.greenBdr : T.redBdr}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, marginBottom: 12 }}>Bénéfice</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: benefice >= 0 ? T.green : T.red, letterSpacing: "-0.02em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{eur(benefice)}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 10 }}>marge {pct(margeNette)}</div>
          </div>
        </div>

        {/* ── KPI Row 2 ────────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 32 }}>
          {([
            { label: "COGS produits",      value: totalCogs,      color: T.red   },
            { label: "Livraison réelle",   value: totalShipping,  color: T.amber },
            { label: "Frais paiement",     value: totalPayFees,   color: T.muted },
            { label: "Dépenses manuelles", value: totalManualExp, color: T.red   },
          ] as const).map(({ label, value, color }) => (
            <div key={label} style={{ ...card, padding: "14px 18px", borderRadius: 12 }}>
              <div style={{ fontSize: 11, color: T.dim, marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 19, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{eur(value)}</div>
            </div>
          ))}
        </div>

        {/* ── Orders table ─────────────────────────────────────────────────── */}
        {filtered.length > 0 ? (
          <div style={{ ...card, overflow: "hidden", marginBottom: 32 }}>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
                Commandes <span style={{ color: T.muted, fontWeight: 400 }}>({filtered.length})</span>
              </span>
              {filtered.length > 50 && (
                <button type="button" onClick={() => setShowAll((v) => !v)}
                  style={{ fontSize: 12, color: T.accent, background: "none", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: T.font }}>
                  {showAll ? "Réduire" : `Voir tout (${filtered.length})`}
                </button>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Commande", "Date", "Cliente", "Pays", "Produit vendu", "Cadeau offert", "Prix payé", "COGS produit", "Coût cadeau", "Port réel", "Frais pmt", "Bénéfice", "Marge %"].map((h) => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayOrders.map((o) => {
                    const dateStr = new Date(o.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
                    const marginPct = o.netPrice > 0 ? (o.margin / o.netPrice) * 100 : 0;
                    return (
                      <tr key={o.id}
                        style={{ borderBottom: `1px solid ${T.border}` }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = T.bg; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        <td style={{ padding: "11px 14px", whiteSpace: "nowrap" }}>
                          <span style={{ fontWeight: 600, color: T.accent, fontSize: 13 }}>{o.name}</span>
                          {o.source === "manuel" && (
                            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 99, background: T.amberBg, color: T.amber, verticalAlign: "middle" }}>
                              manuel
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.muted, whiteSpace: "nowrap" }}>{dateStr}</td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.text, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {o.customerName}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.muted }}>{COUNTRY_LABELS[o.countryCode] ?? (o.country || "—")}</td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.text, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {o.soldLabel}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.muted, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {o.giftLabel || <span style={{ color: T.dim }}>—</span>}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 600, color: T.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {eur(o.netPrice)}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.red, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {o.cogsMain > 0 ? eur(o.cogsMain) : <span style={{ color: T.dim }}>—</span>}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.amber, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {o.cogsGift > 0 ? eur(o.cogsGift) : <span style={{ color: T.dim }}>—</span>}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.amber, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {o.realShipping > 0 ? eur(o.realShipping) : <span style={{ color: T.dim }}>—</span>}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, color: T.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {eur(o.paymentFees)}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 700, color: o.margin >= 0 ? T.green : T.red, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {eur(o.margin)}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 600, color: marginPct >= 50 ? T.green : marginPct >= 25 ? T.amber : T.red, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {pct(marginPct)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: T.bg, borderTop: `2px solid ${T.border}` }}>
                    <td colSpan={6} style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: T.muted }}>
                      Total ({filtered.length})
                    </td>
                    <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 700, color: T.text, fontVariantNumeric: "tabular-nums" }}>{eur(caNet)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(filtered.reduce((s, o) => s + o.cogsMain, 0))}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: T.amber, fontVariantNumeric: "tabular-nums" }}>{eur(filtered.reduce((s, o) => s + o.cogsGift, 0))}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: T.amber, fontVariantNumeric: "tabular-nums" }}>{eur(totalShipping)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(totalPayFees)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 700, color: benefice >= 0 ? T.green : T.red, fontVariantNumeric: "tabular-nums" }}>{eur(filtered.reduce((s, o) => s + o.margin, 0))}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: margeNette >= 50 ? T.green : margeNette >= 25 ? T.amber : T.red, fontVariantNumeric: "tabular-nums" }}>{pct(margeNette)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : (
          <div style={{ ...card, padding: "48px 20px", textAlign: "center", marginBottom: 32 }}>
            <p style={{ margin: 0, fontSize: 14, color: T.muted }}>Aucune commande pour cette période.</p>
          </div>
        )}

        {/* ── Rentabilité par produit ──────────────────────────────────────── */}
        {filtered.length > 0 && (() => {
          const PRODUCT_RANK = ["pot", "2_pots", "3_pots", "kit_decouverte", "kit_ultime", "pot_bol", "pot_cuillere", "pot_fouet_cuillere", "autre"];
          type Acc = { count: number; tPrice: number; tCogsMain: number; tCogsGift: number; tShipping: number; tPayFees: number; tMargin: number };
          const map: Record<string, Acc> = {};
          for (const o of filtered) {
            const k = PRODUCT_RANK.includes(o.productKey) ? o.productKey : "autre";
            if (!map[k]) map[k] = { count: 0, tPrice: 0, tCogsMain: 0, tCogsGift: 0, tShipping: 0, tPayFees: 0, tMargin: 0 };
            map[k].count++;
            map[k].tPrice    += o.netPrice;
            map[k].tCogsMain += o.cogsMain;
            map[k].tCogsGift += o.cogsGift;
            map[k].tShipping += o.realShipping;
            map[k].tPayFees  += o.paymentFees;
            map[k].tMargin   += o.margin;
          }
          const rows = PRODUCT_RANK
            .filter((k) => map[k]?.count > 0)
            .map((k) => {
              const a = map[k];
              const avgPrice = a.tPrice / a.count;
              const mPct     = avgPrice > 0 ? (a.tMargin / a.tPrice) * 100 : 0;
              return { key: k, label: PRODUIT_LABELS[k] ?? k, count: a.count, avgPrice, avgCogsMain: a.tCogsMain / a.count, avgCogsGift: a.tCogsGift / a.count, avgShipping: a.tShipping / a.count, avgPayFees: a.tPayFees / a.count, avgMargin: a.tMargin / a.count, mPct };
            });
          if (rows.length === 0) return null;
          return (
            <div style={{ ...card, overflow: "hidden", marginBottom: 32 }}>
              <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Rentabilité par produit</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: T.muted }}>moyennes par commande · période sélectionnée</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Produit", "Ventes", "Prix moyen", "COGS produit", "Coût cadeau", "Port moyen", "Frais pmt", "Bénéfice moy", "Marge %"].map((h) => (
                        <th key={h} style={th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}
                        style={{ borderBottom: `1px solid ${T.border}` }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = T.bg; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 600, color: T.text, whiteSpace: "nowrap" }}>{r.label}</td>
                        <td style={{ padding: "11px 16px", fontSize: 12, color: T.muted, textAlign: "right" }}>{r.count}</td>
                        <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 600, color: T.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(r.avgPrice)}</td>
                        <td style={{ padding: "11px 16px", fontSize: 12, color: T.red, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(r.avgCogsMain)}</td>
                        <td style={{ padding: "11px 16px", fontSize: 12, color: T.amber, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {r.avgCogsGift > 0 ? eur(r.avgCogsGift) : <span style={{ color: T.dim }}>—</span>}
                        </td>
                        <td style={{ padding: "11px 16px", fontSize: 12, color: T.amber, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(r.avgShipping)}</td>
                        <td style={{ padding: "11px 16px", fontSize: 12, color: T.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(r.avgPayFees)}</td>
                        <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 700, color: r.avgMargin >= 0 ? T.green : T.red, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(r.avgMargin)}</td>
                        <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 700, color: r.mPct >= 50 ? T.green : r.mPct >= 25 ? T.amber : T.red, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{pct(r.mPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* ── UGC costs ────────────────────────────────────────────────────── */}
        <div style={{ ...card, padding: "20px 24px", marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 16 }}>
            Coûts UGC & Collabs{" "}
            <span style={{ color: T.muted, fontWeight: 400, fontSize: 12 }}>(all-time)</span>
          </div>
          <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
            {([
              { label: "COGS produits envoyés", value: ugcStats.cogs     },
              { label: "Frais de port UGC",     value: ugcStats.shipping },
              { label: "Coût total UGC",        value: ugcStats.total    },
            ] as const).map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: 11, color: T.dim, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(value)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Expenses ─────────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24, alignItems: "start" }}>
          <div style={{ ...card, padding: "20px 24px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 16 }}>Ajouter une dépense</div>
            <expenseFetcher.Form method="post">
              <input type="hidden" name="intent" value="create_expense" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <label style={lbl}><span style={lbT}>Nom *</span><input name="label" required placeholder="ex: Facebook Ads" style={inp} /></label>
                <label style={lbl}>
                  <span style={lbT}>Catégorie *</span>
                  <select name="category" required style={inp}>
                    <option value="">Sélectionner…</option>
                    {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label style={lbl}><span style={lbT}>Montant (€) *</span><input name="amount" type="number" step="0.01" min="0" required placeholder="0.00" style={inp} /></label>
                <label style={lbl}><span style={lbT}>Date *</span><input name="date" type="date" required style={inp} /></label>
                <label style={{ ...lbl, gridColumn: "1 / -1" }}><span style={lbT}>Note</span><input name="note" placeholder="optionnel" style={inp} /></label>
              </div>
              <button type="submit" disabled={expenseFetcher.state === "submitting"}
                style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 10, padding: "9px 20px", fontWeight: 600, fontSize: 13, cursor: "pointer", opacity: expenseFetcher.state === "submitting" ? 0.6 : 1, fontFamily: T.font }}>
                {expenseFetcher.state === "submitting" ? "Enregistrement…" : "Ajouter"}
              </button>
            </expenseFetcher.Form>
          </div>

          <div style={{ ...card, padding: "20px 24px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 16 }}>
              Par catégorie{" "}
              <span style={{ color: T.muted, fontWeight: 400, fontSize: 12 }}>{period !== "tout" ? `(${period})` : "(all-time)"}</span>
            </div>
            {Object.keys(expenseByCategory).length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: T.dim }}>Aucune dépense sur cette période.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {Object.entries(expenseByCategory).sort((a, b) => b[1] - a[1]).map(([cat, total]) => (
                  <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: T.text }}>{cat}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(total)}</span>
                  </div>
                ))}
                <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 9, marginTop: 2, display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Total</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totalManualExp)}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Expense list ─────────────────────────────────────────────────── */}
        {expenses.length > 0 && (
          <div style={{ ...card, overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
                Dépenses enregistrées{" "}
                <span style={{ color: T.muted, fontWeight: 400 }}>({expenses.length})</span>
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>{["Date", "Catégorie", "Nom", "Montant", "Note", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id}
                      style={{ borderBottom: `1px solid ${T.border}` }}
                      onMouseEnter={(ev) => { ev.currentTarget.style.background = T.bg; }}
                      onMouseLeave={(ev) => { ev.currentTarget.style.background = "transparent"; }}
                    >
                      <td style={{ padding: "10px 14px", fontSize: 12, color: T.muted, whiteSpace: "nowrap" }}>{e.date}</td>
                      <td style={{ padding: "10px 14px" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 99, background: T.accentBg, color: T.accent }}>{e.category}</span>
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 12, fontWeight: 600, color: T.text }}>{e.label}</td>
                      <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(e.amount)}</td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: T.dim, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.note ?? "—"}</td>
                      <td style={{ padding: "10px 14px" }}>
                        <expenseFetcher.Form method="post" style={{ display: "contents" }}>
                          <input type="hidden" name="intent" value="delete_expense" />
                          <input type="hidden" name="id" value={e.id} />
                          <button type="submit"
                            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: `1px solid ${T.redBdr}`, background: "none", color: T.red, cursor: "pointer", fontWeight: 600, fontFamily: T.font }}>
                            Supprimer
                          </button>
                        </expenseFetcher.Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
