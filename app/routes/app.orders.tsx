import { useState } from "react";
import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseUgcProduit, coutComps, ugcShippingCost } from "../utils/ugc";

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
  cogs: number;
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

  console.log("ORDERS PAGINATION START");

  while (hasNext && pages < 20) {
    const resp = await admin.graphql(ORDERS_QUERY, { variables: { cursor } });
    const json = await resp.json() as {
      data?: { orders?: { edges: { node: unknown }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      errors?: unknown;
    };

    if (json.errors) {
      console.error(`ORDERS PAGE ${pages + 1} GRAPHQL ERRORS`, JSON.stringify(json.errors));
    }

    const page = json.data?.orders;
    if (!page) {
      console.error(`ORDERS PAGE ${pages + 1} — data.orders absent`, JSON.stringify(json));
      break;
    }

    const names = page.edges.map((e) => (e.node as { name?: string }).name ?? "?");
    console.log(
      `ORDERS PAGE ${pages + 1}: ${page.edges.length} commandes [${names.join(", ")}] | hasNextPage=${page.pageInfo.hasNextPage} | endCursor=${page.pageInfo.endCursor ?? "null"}`,
    );

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
        cogs,
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

  console.log(`ORDERS PAGINATION END — total récupéré : ${all.length} commandes [${all.map((o) => o.name).join(", ")}]`);
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
    cogs,
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

  console.log("REST FETCH START", url);

  while (url && page <= 20) {
    const currentUrl: string = url;
    const resp: Response = await fetch(currentUrl, {
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`REST PAGE ${page} HTTP ${resp.status}`, body);
      break;
    }

    const json = await resp.json() as { orders?: RestOrder[] };
    const raw  = json.orders ?? [];

    console.log(
      `REST PAGE ${page}: ${raw.length} commandes [${raw.map((o) => `${o.name}(#${o.order_number},${o.financial_status}${o.cancelled_at ? ",annulée" : ""}${o.test ? ",test" : ""})`).join(", ")}]`,
    );

    for (const o of raw) all.push(parseRestOrder(o));

    // Pagination via Link header
    const link: string              = resp.headers.get("Link") ?? "";
    const nextMatch: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    page++;
  }

  console.log(`REST FETCH END — total : ${all.length} commandes [${all.map((o) => o.name).join(", ")}]`);
  return all;
}

// ─── Fetch par ID (diagnostic + force-récupération) ──────────────────────────

const FORCED_ORDER_IDS: string[] = [
  "12681351856512", // #1001
  "12685418529152", // #1002
  "12700950102400", // #1003
];

async function fetchOrderByIdREST(
  session: { shop: string; accessToken: string },
  id: string,
): Promise<Order | null> {
  const url = `https://${session.shop}/admin/api/2026-07/orders/${id}.json`;
  console.log(`REST BY-ID fetch → ${url}`);

  const resp: Response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": session.accessToken,
      "Content-Type": "application/json",
    },
  });

  const body = await resp.text();

  if (!resp.ok) {
    console.error(`REST BY-ID ${id} → HTTP ${resp.status}`, body);
    return null;
  }

  let json: { order?: RestOrder };
  try {
    json = JSON.parse(body) as { order?: RestOrder };
  } catch {
    console.error(`REST BY-ID ${id} — JSON parse error`, body);
    return null;
  }

  const o = json.order;
  if (!o) {
    console.error(`REST BY-ID ${id} — champ "order" absent`, body);
    return null;
  }

  console.log(
    `REST BY-ID ${id} OK → name=${o.name} order_number=${o.order_number} created_at=${o.created_at} financial_status=${o.financial_status}`,
  );
  return parseRestOrder(o);
}

async function forceInjectMissingOrders(
  session: { shop: string; accessToken: string },
  orders: Order[],
): Promise<Order[]> {
  const existingIds = new Set(orders.map((o) => o.id));
  const injected: Order[] = [];

  for (const id of FORCED_ORDER_IDS) {
    if (existingIds.has(id)) {
      console.log(`FORCE-INJECT ${id} — déjà présent, skip`);
      continue;
    }
    const order = await fetchOrderByIdREST(session, id);
    if (order) {
      injected.push(order);
      console.log(`FORCE-INJECT ${id} → injecté (${order.name})`);
    } else {
      console.warn(`FORCE-INJECT ${id} → introuvable ou inaccessible`);
    }
  }

  if (injected.length === 0) return orders;

  // Merge + déduplique par id + tri décroissant (plus récent en premier)
  const merged = new Map<string, Order>();
  for (const o of [...orders, ...injected]) merged.set(o.id, o);
  return [...merged.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { admin, session } = await authenticate.admin(request) as any;
  const sess = session as { shop: string; accessToken: string };

  let orders: Order[] = [];
  let fetchError: string | null = null;
  let source = "rest";

  // 1. Liste complète via REST (status=any)
  try {
    orders = await fetchOrdersREST(sess);
  } catch (e) {
    console.error("REST FETCH ERROR", e);
    source = "graphql-fallback";

    // 2. Fallback GraphQL si REST échoue entièrement
    try {
      orders = await fetchAllOrders(admin);
    } catch (e2) {
      fetchError = String(e2);
      console.error("GRAPHQL FETCH ERROR", e2);
    }
  }

  console.log(`ORDERS SOURCE: ${source} — ${orders.length} commandes avant force-inject`);

  // 3. Force-injection des IDs connus manquants
  try {
    orders = await forceInjectMissingOrders(sess, orders);
  } catch (e) {
    console.error("FORCE-INJECT ERROR", e);
  }

  console.log(`ORDERS FINAL: ${orders.length} commandes [${orders.map((o) => o.name).join(", ")}]`);

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
  bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", dim: "#94a3b8",
  accent: "#6366f1", green: "#059669", greenBg: "#f0fdf4",
  orange: "#d97706", orangeBg: "#fffbeb",
  red: "#dc2626", redBg: "#fef2f2", redBdr: "#fca5a5",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
};

const inp: React.CSSProperties = { border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, width: "100%", boxSizing: "border-box", background: "#fff" };
const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const lbT: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em" };
const cell: React.CSSProperties = { padding: "7px 10px", color: "#0f172a", fontSize: 12 };

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

function financialBadge(status: string): React.CSSProperties {
  if (status === "PAID")     return { background: "#f0fdf4", color: "#059669" };
  if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return { background: "#fef2f2", color: "#dc2626" };
  if (status === "PENDING")  return { background: "#fffbeb", color: "#d97706" };
  return { background: "#f1f5f9", color: "#64748b" };
}

function fulfillmentBadge(status: string): React.CSSProperties {
  if (status === "FULFILLED") return { background: "#f0fdf4", color: "#059669" };
  if (status === "UNFULFILLED" || status === "OPEN") return { background: "#fffbeb", color: "#d97706" };
  return { background: "#f1f5f9", color: "#64748b" };
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

  const [debugSearch, setDebugSearch] = useState("");

  // Filters
  const [period, setPeriod]       = useState("tout");
  const [country, setCountry]     = useState("");
  const [finStatus, setFinStatus] = useState("");
  const [fulStatus, setFulStatus] = useState("");
  const [showAll, setShowAll]     = useState(false);

  // Filter orders — each exclusion tracked separately for the debug bar
  const cutoff = periodCutoff(period);
  const excludedByPeriod  = cutoff ? orders.filter((o) => new Date(o.createdAt) < cutoff) : [];
  const afterPeriod       = cutoff ? orders.filter((o) => new Date(o.createdAt) >= cutoff) : orders;
  const excludedByCountry = country   ? afterPeriod.filter((o) => o.countryCode     !== country)   : [];
  const excludedByFin     = finStatus ? afterPeriod.filter((o) => o.financialStatus !== finStatus) : [];
  const excludedByFul     = fulStatus ? afterPeriod.filter((o) => o.fulfillmentStatus !== fulStatus) : [];

  const filtered = orders.filter((o) => {
    if (cutoff && new Date(o.createdAt) < cutoff) return false;
    if (country   && o.countryCode       !== country)   return false;
    if (finStatus && o.financialStatus   !== finStatus) return false;
    if (fulStatus && o.fulfillmentStatus !== fulStatus) return false;
    return true;
  });

  const totalExcluded = orders.length - filtered.length;

  const debugOrders = debugSearch.trim()
    ? orders.filter((o) => o.name.toLowerCase().includes(debugSearch.toLowerCase()) || o.customerName.toLowerCase().includes(debugSearch.toLowerCase()))
    : orders;

  // Filter expenses by period
  const filteredExpenses = expenses.filter((e) => {
    if (!cutoff) return true;
    return new Date(e.date) >= cutoff;
  });

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

  const cardStyle: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: 14, padding: "16px 18px", boxShadow: T.shadow,
  };

  const kpiLabel: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, textTransform: "uppercase",
    color: T.dim, marginBottom: 4, letterSpacing: "0.06em",
  };

  const kpiVal: React.CSSProperties = {
    fontSize: 22, fontWeight: 700, color: T.text, fontVariantNumeric: "tabular-nums",
  };

  const selectFilter: React.CSSProperties = {
    ...inp, width: "auto", fontSize: 12, padding: "5px 10px",
  };

  const periodBtn = (p: string): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer",
    fontWeight: period === p ? 700 : 400,
    background: period === p ? T.accent : "#f1f5f9",
    color: period === p ? "#fff" : T.muted,
    border: "none",
  });

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "32px 24px 60px", fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', boxSizing: "border-box" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 8 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: T.text }}>Commandes & Rentabilité</h1>
            <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>
              {orders.length} commandes au total · {filtered.length} affichées
            </p>
          </div>
          <a href="/app" style={{ fontSize: 12, color: T.accent, textDecoration: "none", border: "1px solid #c7d2fe", padding: "4px 12px", borderRadius: 8 }}>
            ← Dashboard
          </a>
        </div>

        {fetchError && (
          <div style={{ background: T.redBg, border: `1px solid ${T.redBdr}`, borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, color: T.red }}>
            Erreur de chargement des commandes Shopify : {fetchError}
          </div>
        )}

        {/* Debug / compteur */}
        <div style={{ background: "#f8fafc", border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 16px", marginBottom: 14, fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontWeight: 700, color: T.text }}>Shopify : {orders.length} commande{orders.length > 1 ? "s" : ""} récupérée{orders.length > 1 ? "s" : ""}</span>
          <span style={{ color: T.green, fontWeight: 600 }}>Affichées : {filtered.length}</span>
          {totalExcluded > 0 && (
            <span style={{ color: T.orange, fontWeight: 600 }}>Masquées par filtres : {totalExcluded}</span>
          )}
          {excludedByPeriod.length > 0 && (
            <span style={{ color: T.muted }}>
              Période ({period}) : {excludedByPeriod.length} cachée{excludedByPeriod.length > 1 ? "s" : ""} —{" "}
              <span style={{ color: T.orange }}>{excludedByPeriod.slice(0, 8).map((o) => o.name).join(", ")}{excludedByPeriod.length > 8 ? "…" : ""}</span>
            </span>
          )}
          {excludedByCountry.length > 0 && <span style={{ color: T.muted }}>Pays : {excludedByCountry.length} cachée{excludedByCountry.length > 1 ? "s" : ""}</span>}
          {excludedByFin.length > 0     && <span style={{ color: T.muted }}>Paiement : {excludedByFin.length} cachée{excludedByFin.length > 1 ? "s" : ""}</span>}
          {excludedByFul.length > 0     && <span style={{ color: T.muted }}>Livraison : {excludedByFul.length} cachée{excludedByFul.length > 1 ? "s" : ""}</span>}
          {orders.length === 0 && !fetchError && <span style={{ color: T.red, fontWeight: 600 }}>Aucune commande reçue de Shopify — voir logs Render</span>}
        </div>

        {/* ── DEBUG TABLE : toutes les commandes brutes, sans aucun filtre ── */}
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "14px 18px", marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#92400e", letterSpacing: "0.07em" }}>
              DEBUG — {orders.length} commande{orders.length !== 1 ? "s" : ""} brutes Shopify (query: status:any, aucun filtre UI)
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#78350f" }}>Chercher :</span>
              <input
                value={debugSearch}
                onChange={(e) => setDebugSearch(e.target.value)}
                placeholder="#1001 ou nom…"
                style={{ fontSize: 11, padding: "3px 8px", border: "1px solid #fde68a", borderRadius: 6, background: "#fffde7", width: 130 }}
              />
            </div>
          </div>
          {orders.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: "#92400e" }}>
              Shopify n'a renvoyé aucune commande. Voir logs Render (=== DIAGNOSTIC ORDERS ===) pour identifier la cause.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "#fef3c7" }}>
                    {["N°", "Date", "Pays", "Total orig.", "Net actuel", "Paiement", "Livraison", "Annulée", "Archivée", "Test", "Produits"].map((h) => (
                      <th key={h} style={{ padding: "5px 8px", textAlign: "left", fontWeight: 600, color: "#78350f", whiteSpace: "nowrap", borderBottom: "1px solid #fde68a" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {debugOrders.map((o, i) => (
                    <tr key={o.id} style={{ background: i % 2 === 0 ? "#fffde7" : "#fffbeb", borderTop: "1px solid #fde68a" }}>
                      <td style={{ padding: "4px 8px", fontWeight: 700, color: "#92400e" }}>{o.name}</td>
                      <td style={{ padding: "4px 8px", color: "#78350f", whiteSpace: "nowrap" }}>{new Date(o.createdAt).toLocaleDateString("fr-FR")}</td>
                      <td style={{ padding: "4px 8px", color: "#78350f" }}>{o.countryCode || "?"}</td>
                      <td style={{ padding: "4px 8px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.totalPrice)}</td>
                      <td style={{ padding: "4px 8px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.netPrice)}</td>
                      <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{o.financialStatus || "—"}</td>
                      <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{o.fulfillmentStatus || "—"}</td>
                      <td style={{ padding: "4px 8px" }}>
                        {o.cancelledAt ? <span style={{ color: "#dc2626", fontWeight: 700 }}>OUI {new Date(o.cancelledAt).toLocaleDateString("fr-FR")}</span> : <span style={{ color: "#78350f" }}>non</span>}
                      </td>
                      <td style={{ padding: "4px 8px" }}>
                        {o.closed ? <span style={{ color: "#d97706", fontWeight: 700 }}>OUI</span> : <span style={{ color: "#78350f" }}>non</span>}
                      </td>
                      <td style={{ padding: "4px 8px" }}>
                        {o.test ? <span style={{ color: "#6366f1", fontWeight: 700 }}>TEST</span> : <span style={{ color: "#78350f" }}>non</span>}
                      </td>
                      <td style={{ padding: "4px 8px", color: "#78350f", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {o.lineItems.map((li) => `${li.quantity}× ${li.title}`).join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Filters */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 18px", marginBottom: 20, boxShadow: T.shadow }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 4 }}>
              {["7j", "30j", "90j", "6m", "12m", "tout"].map((p) => (
                <button key={p} type="button" onClick={() => setPeriod(p)} style={periodBtn(p)}>{p}</button>
              ))}
            </div>
            <select value={country}   onChange={(e) => setCountry(e.target.value)}   style={selectFilter}>
              <option value="">Tous les pays</option>
              {countries.map((c) => <option key={c} value={c}>{COUNTRY_LABELS[c] ?? c}</option>)}
            </select>
            <select value={finStatus} onChange={(e) => setFinStatus(e.target.value)} style={selectFilter}>
              <option value="">Paiement (tous)</option>
              {finStatuses.map((s) => <option key={s} value={s}>{FINANCIAL_LABELS[s] ?? s}</option>)}
            </select>
            <select value={fulStatus} onChange={(e) => setFulStatus(e.target.value)} style={selectFilter}>
              <option value="">Livraison (tous)</option>
              {fulStatuses.map((s) => <option key={s} value={s}>{FULFILLMENT_LABELS[s] ?? s}</option>)}
            </select>
          </div>
        </div>

        {/* KPI Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 12 }}>
          <div style={cardStyle}>
            <div style={kpiLabel}>Commandes</div>
            <div style={kpiVal}>{filtered.length}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
              {nbClientes} clientes · panier {eur(panierMoyen)}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={kpiLabel}>CA brut</div>
            <div style={{ ...kpiVal, color: T.green }}>{eur(caBrut)}</div>
            {remboursements > 0 && <div style={{ fontSize: 11, color: T.red, marginTop: 2 }}>−{eur(remboursements)} remb.</div>}
          </div>
          <div style={cardStyle}>
            <div style={kpiLabel}>CA net</div>
            <div style={{ ...kpiVal, color: T.text }}>{eur(caNet)}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>après remboursements</div>
          </div>
          <div style={{ ...cardStyle, background: T.redBg, border: `1px solid ${T.redBdr}` }}>
            <div style={kpiLabel}>Total charges</div>
            <div style={{ ...kpiVal, color: T.red }}>{eur(totalCharges)}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
              COGS {eur(totalCogs)} · Port {eur(totalShipping)}
            </div>
          </div>
          <div style={{ ...cardStyle, background: benefice >= 0 ? T.greenBg : T.redBg, border: `1px solid ${benefice >= 0 ? "#86efac" : T.redBdr}` }}>
            <div style={kpiLabel}>Bénéfice estimé</div>
            <div style={{ ...kpiVal, color: benefice >= 0 ? T.green : T.red }}>{eur(benefice)}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>marge {pct(margeNette)}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
          <div style={cardStyle}>
            <div style={kpiLabel}>COGS produits</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totalCogs)}</div>
          </div>
          <div style={cardStyle}>
            <div style={kpiLabel}>Livraison réelle</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.orange, fontVariantNumeric: "tabular-nums" }}>{eur(totalShipping)}</div>
          </div>
          <div style={cardStyle}>
            <div style={kpiLabel}>Frais paiement ~1,5%</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(totalPayFees)}</div>
          </div>
          <div style={cardStyle}>
            <div style={kpiLabel}>Dépenses manuelles</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totalManualExp)}</div>
          </div>
        </div>

        {/* Orders table */}
        {filtered.length > 0 && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow, marginBottom: 32 }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.muted }}>
                Commandes ({filtered.length})
              </span>
              {filtered.length > 50 && (
                <button type="button" onClick={() => setShowAll((v) => !v)} style={{ fontSize: 12, color: T.accent, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                  {showAll ? "Afficher les 50 premières" : `Voir tout (${filtered.length})`}
                </button>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["N° commande", "Date", "Cliente", "Pays", "Produits", "Total payé", "Réduction", "Livr. fact.", "Statut paiement", "Statut livraison", "COGS", "Port réel", "Frais pay.", "Marge"].map((h) => (
                      <th key={h} style={{ padding: "9px 10px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}`, fontSize: 11 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayOrders.map((o, i) => {
                    const rowBg = i % 2 === 0 ? "#fff" : "#f8fafc";
                    const finStyle = financialBadge(o.financialStatus);
                    const fulStyle = fulfillmentBadge(o.fulfillmentStatus);
                    const marginColor = o.margin >= 0 ? T.green : T.red;
                    const dateStr = new Date(o.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
                    const products = o.lineItems.map((li) => `${li.quantity}× ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ""}`).join(", ");

                    return (
                      <tr key={o.id} style={{ borderTop: `1px solid ${T.border}`, background: rowBg }}>
                        <td style={{ ...cell, fontWeight: 600, color: T.accent, whiteSpace: "nowrap" }}>{o.name}</td>
                        <td style={{ ...cell, color: T.muted, whiteSpace: "nowrap" }}>{dateStr}</td>
                        <td style={{ ...cell, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <div>{o.customerName}</div>
                        </td>
                        <td style={{ ...cell, color: T.muted }}>{COUNTRY_LABELS[o.countryCode] ?? (o.country || "—")}</td>
                        <td style={{ ...cell, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.muted }}>{products}</td>
                        <td style={{ ...cell, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.totalPrice)}</td>
                        <td style={{ ...cell, color: o.discountTotal > 0 ? T.orange : T.dim, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {o.discountTotal > 0 ? `−${eur(o.discountTotal)}` : "—"}
                        </td>
                        <td style={{ ...cell, color: T.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.shippingPrice)}</td>
                        <td style={cell}>
                          <span style={{ ...finStyle, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99, whiteSpace: "nowrap" }}>
                            {FINANCIAL_LABELS[o.financialStatus] ?? o.financialStatus}
                          </span>
                        </td>
                        <td style={cell}>
                          <span style={{ ...fulStyle, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99, whiteSpace: "nowrap" }}>
                            {FULFILLMENT_LABELS[o.fulfillmentStatus] ?? (o.fulfillmentStatus || "—")}
                          </span>
                        </td>
                        <td style={{ ...cell, color: T.red, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.cogs)}</td>
                        <td style={{ ...cell, color: T.orange, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.realShipping)}</td>
                        <td style={{ ...cell, color: T.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.paymentFees)}</td>
                        <td style={{ ...cell, fontWeight: 700, color: marginColor, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(o.margin)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                    <td colSpan={5} style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: T.text }}>Total</td>
                    <td style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: T.text, fontVariantNumeric: "tabular-nums" }}>{eur(caBrut)}</td>
                    <td style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: T.orange, fontVariantNumeric: "tabular-nums" }}>
                      {filtered.reduce((s, o) => s + o.discountTotal, 0) > 0 ? `−${eur(filtered.reduce((s, o) => s + o.discountTotal, 0))}` : "—"}
                    </td>
                    <td style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: T.muted, fontVariantNumeric: "tabular-nums" }}>
                      {eur(filtered.reduce((s, o) => s + o.shippingPrice, 0))}
                    </td>
                    <td colSpan={2} />
                    <td style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totalCogs)}</td>
                    <td style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: T.orange, fontVariantNumeric: "tabular-nums" }}>{eur(totalShipping)}</td>
                    <td style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(totalPayFees)}</td>
                    <td style={{ padding: "9px 10px", fontWeight: 700, fontSize: 12, color: benefice >= 0 ? T.green : T.red, fontVariantNumeric: "tabular-nums" }}>{eur(filtered.reduce((s, o) => s + o.margin, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* UGC recap */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 20, marginBottom: 28, boxShadow: T.shadow }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.muted, marginBottom: 14 }}>Coûts UGC & Collabs (total all-time)</div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            {[
              { label: "COGS produits envoyés", value: ugcStats.cogs },
              { label: "Frais de port UGC", value: ugcStats.shipping },
              { label: "Coût total UGC", value: ugcStats.total },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: 11, color: T.dim, marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(value)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Expenses */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>

          {/* Add expense form */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 20, boxShadow: T.shadow }}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.muted, marginBottom: 16 }}>Ajouter une dépense</div>
            <expenseFetcher.Form method="post">
              <input type="hidden" name="intent" value="create_expense" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <label style={lbl}>
                  <span style={lbT}>Nom *</span>
                  <input name="label" required placeholder="ex: Facebook Ads Jan." style={inp} />
                </label>
                <label style={lbl}>
                  <span style={lbT}>Catégorie *</span>
                  <select name="category" required style={inp}>
                    <option value="">Sélectionner…</option>
                    {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label style={lbl}>
                  <span style={lbT}>Montant (€) *</span>
                  <input name="amount" type="number" step="0.01" min="0" required placeholder="0.00" style={inp} />
                </label>
                <label style={lbl}>
                  <span style={lbT}>Date *</span>
                  <input name="date" type="date" required style={inp} />
                </label>
                <label style={{ ...lbl, gridColumn: "1 / -1" }}>
                  <span style={lbT}>Note</span>
                  <input name="note" placeholder="optionnel" style={inp} />
                </label>
              </div>
              <button
                type="submit"
                disabled={expenseFetcher.state === "submitting"}
                style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 10, padding: "9px 18px", fontWeight: 600, fontSize: 13, cursor: "pointer", opacity: expenseFetcher.state === "submitting" ? 0.6 : 1 }}
              >
                {expenseFetcher.state === "submitting" ? "Enregistrement…" : "Ajouter"}
              </button>
            </expenseFetcher.Form>
          </div>

          {/* Expense breakdown */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 20, boxShadow: T.shadow }}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.muted, marginBottom: 14 }}>
              Dépenses par catégorie {period !== "tout" ? `(${period})` : "(all-time)"}
            </div>
            {Object.keys(expenseByCategory).length === 0 ? (
              <p style={{ fontSize: 12, color: T.dim, margin: 0 }}>Aucune dépense sur cette période.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {Object.entries(expenseByCategory)
                  .sort((a, b) => b[1] - a[1])
                  .map(([cat, total]) => (
                    <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: T.text }}>{cat}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(total)}</span>
                    </div>
                  ))}
                <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 4, display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Total</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totalManualExp)}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Expense list */}
        {expenses.length > 0 && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow, marginTop: 20 }}>
            <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.muted }}>
                Dépenses enregistrées ({expenses.length})
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["Date", "Catégorie", "Nom", "Montant", "Note", ""].map((h) => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e, i) => (
                    <tr key={e.id} style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                      <td style={{ ...cell, color: T.muted, whiteSpace: "nowrap" }}>{e.date}</td>
                      <td style={cell}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 99, background: "#eef2ff", color: T.accent }}>
                          {e.category}
                        </span>
                      </td>
                      <td style={{ ...cell, fontWeight: 600 }}>{e.label}</td>
                      <td style={{ ...cell, color: T.red, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{eur(e.amount)}</td>
                      <td style={{ ...cell, color: T.dim, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.note ?? "—"}</td>
                      <td style={cell}>
                        <expenseFetcher.Form method="post" style={{ display: "contents" }}>
                          <input type="hidden" name="intent" value="delete_expense" />
                          <input type="hidden" name="id" value={e.id} />
                          <button type="submit" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: "1px solid #fca5a5", background: "none", color: "#ef4444", cursor: "pointer", fontWeight: 600 }}>
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
