import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SHIPPING_LABELS, shippingStyle, CONTENT_LABELS, contentStyle } from "../utils/ugc";

// ─── Constantes métier ────────────────────────────────────────────────────────

const COUT = { pot: 3.77055, fouet: 4.1806, bol: 4.1806, cuillere: 2.40 } as const;
const STOCK_INIT = { pots: 200, fouets: 100, bols: 100, cuilleres: 100 } as const;

// ─── Helpers généraux ────────────────────────────────────────────────────────

async function safeGet<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

type AdminClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

// ─── Composants : types & fonctions ──────────────────────────────────────────

interface Comps { pots: number; fouets: number; bols: number; cuilleres: number; }
const ZERO: Comps = { pots: 0, fouets: 0, bols: 0, cuilleres: 0 };

function add(a: Comps, b: Comps): Comps {
  return { pots: a.pots + b.pots, fouets: a.fouets + b.fouets, bols: a.bols + b.bols, cuilleres: a.cuilleres + b.cuilleres };
}

function cogs(c: Comps): number {
  return c.pots * COUT.pot + c.fouets * COUT.fouet + c.bols * COUT.bol + c.cuilleres * COUT.cuillere;
}

function fmtComps(c: Comps): string {
  const p: string[] = [];
  if (c.pots > 0)      p.push(`${c.pots} pot${c.pots > 1 ? "s" : ""}`);
  if (c.fouets > 0)    p.push(`${c.fouets} fouet${c.fouets > 1 ? "s" : ""}`);
  if (c.bols > 0)      p.push(`${c.bols} bol${c.bols > 1 ? "s" : ""}`);
  if (c.cuilleres > 0) p.push(`${c.cuilleres} cuillère${c.cuilleres > 1 ? "s" : ""}`);
  return p.join(" + ") || "?";
}

// Mapping titre Shopify → composants
function titleToComps(title: string, qty: number): Comps {
  const t = title.toLowerCase();
  if (t.includes("kit ultime"))                                          return { pots: qty, fouets: qty, bols: qty,  cuilleres: 0   };
  if (t.includes("kit découverte") || t.includes("kit decouverte"))     return { pots: qty, fouets: qty, bols: 0,    cuilleres: 0   };
  if (t.includes("fouet"))                                               return { pots: 0,   fouets: qty, bols: 0,    cuilleres: 0   };
  if (t.includes("cuillère") || t.includes("cuillere"))                 return { pots: 0,   fouets: 0,   bols: 0,    cuilleres: qty };
  if (t.includes("bol"))                                                 return { pots: 0,   fouets: 0,   bols: qty,  cuilleres: 0   };
  if (t.includes("3 pot") || t.includes("3pot"))                        return { pots: 3 * qty, fouets: 0, bols: 0,  cuilleres: 0   };
  if (t.includes("2 pot") || t.includes("2pot"))                        return { pots: 2 * qty, fouets: 0, bols: 0,  cuilleres: 0   };
  return { pots: qty, fouets: 0, bols: 0, cuilleres: 0 }; // pot seul
}

// Mapping type ProduitOffert / Creator → composants
function produitTypeToComps(produit: string, qty: number): Comps {
  switch (produit) {
    case "pot":               return { pots: qty,      fouets: 0,   bols: 0,   cuilleres: 0   };
    case "2_pots":            return { pots: 2 * qty,  fouets: 0,   bols: 0,   cuilleres: 0   };
    case "3_pots":            return { pots: 3 * qty,  fouets: 0,   bols: 0,   cuilleres: 0   };
    case "kit_decouverte":    return { pots: qty,      fouets: qty, bols: 0,   cuilleres: 0   };
    case "kit_ultime":        return { pots: qty,      fouets: qty, bols: qty, cuilleres: 0   };
    case "fouet":             return { pots: 0,        fouets: qty, bols: 0,   cuilleres: 0   };
    case "bol":               return { pots: 0,        fouets: 0,   bols: qty, cuilleres: 0   };
    case "cuillere":          return { pots: 0,        fouets: 0,   bols: 0,   cuilleres: qty };
    case "pot_cuillere":      return { pots: qty,      fouets: 0,   bols: 0,   cuilleres: qty };
    case "pot_fouet_cuillere":return { pots: qty,      fouets: qty, bols: 0,   cuilleres: qty };
    default:                  return ZERO;
  }
}

// ─── Shopify orders ───────────────────────────────────────────────────────────

const ORDERS_QUERY = `
  query GetOrders($cursor: String) {
    orders(first: 100, sortKey: CREATED_AT, reverse: true, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id name createdAt
          displayFinancialStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress { countryCode }
          lineItems(first: 10) {
            edges { node { title quantity } }
          }
        }
      }
    }
  }
`;

interface OrderNode {
  id?: string; name?: string; createdAt?: string;
  displayFinancialStatus?: string;
  currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  shippingAddress?: { countryCode?: string };
  lineItems?: { edges: { node: { title?: string; quantity?: number } }[] };
}

interface LineBreakdown { title: string; qty: number; comps: Comps; itemCogs: number; }

interface OrderBreakdown {
  name: string; revenue: number; country: string;
  items: LineBreakdown[];
  orderComps: Comps; orderCogs: number; shipping: number;
  displayFinancialStatus: string;
  isRefunded: boolean;
}

function shippingCost(items: LineBreakdown[], country: string): number {
  const c = country.toUpperCase();
  const hasBol   = items.some(i => i.comps.bols > 0);
  const hasFouet = items.some(i => i.comps.fouets > 0);
  const pots     = items.reduce((s, i) => s + i.comps.pots, 0);
  switch (c) {
    case "FR": return hasBol ? 9.29 : hasFouet ? 5.49 : pots >= 3 ? 7.59 : 5.49;
    case "BE": return hasBol ? 6.60 : 4.60;
    case "IT": return hasBol ? 9.50 : 6.60;
    case "DE": return hasBol ? 13.80 : 12.50;
    case "CH": return hasBol ? 19.39 : 14.99;
    default:   return 0;
  }
}

interface ShopifyResult {
  revenue: number; shipping: number; cogsSales: number;
  salesComps: Comps;
  orderCount: number;   // toutes commandes (affichage)
  paidCount: number;    // hors remboursées (métriques par commande)
  orderBreakdowns: OrderBreakdown[]; scopeError: boolean;
}

async function fetchShopifyOrders(admin: AdminClient, shop: string): Promise<ShopifyResult> {
  const zero: ShopifyResult = { revenue: 0, shipping: 0, cogsSales: 0, salesComps: { ...ZERO }, orderCount: 0, paidCount: 0, orderBreakdowns: [], scopeError: false };
  try {
    let cursor: string | null = null;
    const allNodes: OrderNode[] = [];

    do {
      const res = await admin.graphql(ORDERS_QUERY, { variables: { cursor } });
      const rawText = await res.text();

      let data: {
        data?: { orders?: { pageInfo: { hasNextPage: boolean; endCursor: string }; edges: { node: OrderNode }[] } };
        errors?: { message?: string; extensions?: unknown }[];
      };
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        console.error(`[Dashboard] JSON parse error (${shop}):`, e);
        break;
      }

      if (data.errors?.length) {
        console.error(`[Dashboard] GraphQL error (${shop}):`, JSON.stringify(data.errors));
        return { ...zero, scopeError: data.errors.some(e => e.message?.toLowerCase().includes("access denied") || e.message?.toLowerCase().includes("read_orders")) };
      }

      const page = data.data?.orders;
      if (!page) {
        console.warn(`[Dashboard] data.data.orders est null/undefined — raw keys: ${Object.keys(data.data ?? {}).join(",") || "aucun"}`);
        break;
      }

      for (const { node } of page.edges) allNodes.push(node);

      if (page.pageInfo.hasNextPage) {
        cursor = page.pageInfo.endCursor;
      } else {
        break;
      }
    } while (true);

    let revenue = 0, shipping = 0, cogsSales = 0, orderCount = 0, paidCount = 0;
    let salesComps: Comps = { ...ZERO };
    const orderBreakdowns: OrderBreakdown[] = [];

    for (const node of allNodes) {
      // Statut basé UNIQUEMENT sur displayFinancialStatus — jamais sur les montants
      const displayStatus = (node.displayFinancialStatus ?? "").toUpperCase();
      const isRefunded    = displayStatus === "REFUNDED";   // PARTIALLY_REFUNDED ≠ remboursé
      const totalPrice    = parseFloat(node.currentTotalPriceSet?.shopMoney?.amount ?? "0");
      const rev           = totalPrice;

      const country = (node.shippingAddress?.countryCode ?? "").toUpperCase();
      const items: LineBreakdown[] = (node.lineItems?.edges ?? []).map(({ node: li }) => {
        const comps    = titleToComps(li.title ?? "", li.quantity ?? 1);
        const itemCogs = cogs(comps);
        return { title: li.title ?? "", qty: li.quantity ?? 1, comps, itemCogs };
      });
      const orderComps = items.reduce((acc, i) => add(acc, i.comps), { ...ZERO });
      const orderCogs  = cogs(orderComps);
      const ship       = shippingCost(items, country);

      orderCount++; // toutes commandes sans exception
      if (!isRefunded) {
        revenue   += rev;
        shipping  += ship;
        cogsSales += orderCogs;
        salesComps = add(salesComps, orderComps);
        paidCount++;
      }

      orderBreakdowns.push({
        name: node.name ?? "#?",
        revenue: rev,
        country: country || "?",
        items,
        orderComps, orderCogs,
        shipping: ship,
        displayFinancialStatus: displayStatus,
        isRefunded,
      });
    }
    return { revenue, shipping, cogsSales, salesComps, orderCount, paidCount, orderBreakdowns, scopeError: false };
  } catch (err) {
    console.error(`[Dashboard] fetchShopifyOrders error (${shop}):`, err);
    return zero;
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [shopify, creators, produitsOfferts, rawExpenses] = await Promise.all([
    fetchShopifyOrders(admin as AdminClient, session.shop),
    safeGet(() => prisma.creator.findMany({ orderBy: { createdAt: "asc" } }), [] as Array<{
      id: string; nom: string; instagram: string; type: string | null; pays: string;
      produit: string; quantite: number; statut: string;
      shippingStatus: string; contentStatus: string;
      fraisPort: number; trackingNumber: string | null;
      coutProduit: number | null; coutTotalCollab: number | null; notes: string | null;
      codePromo: string | null; dateLivraison: string | null;
    }>),
    safeGet(() => prisma.produitOffert.findMany({ orderBy: { date: "desc" } }),
      [] as Array<{ produit: string; quantite: number; coutTotal: number }>),
    safeGet(() => prisma.expense.findMany({ orderBy: { date: "desc" } }),
      [] as Array<{ id: string; date: Date; category: string; label: string; amount: number; type: string; note: string | null }>),
  ]);

  const expenses = rawExpenses;

  // ── UGC / Creator → composants + coûts ──────────────────────────────────────
  let ugcComps: Comps = { ...ZERO };
  let ugcCogs = 0;
  let ugcShipping = 0;
  for (const c of creators) {
    const comps = produitTypeToComps(c.produit, c.quantite);
    ugcComps    = add(ugcComps, comps);
    ugcCogs    += cogs(comps);
    ugcShipping += c.fraisPort;
  }
  const nbCreateurs = creators.length;
  const nbByShipping = creators.reduce((acc, c) => {
    acc[c.shippingStatus] = (acc[c.shippingStatus] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const nbByContent = creators.reduce((acc, c) => {
    acc[c.contentStatus] = (acc[c.contentStatus] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const nbContents   = creators.filter(c => c.trackingNumber).length;
  const ugcCoutMoyen = nbCreateurs > 0 ? (ugcCogs + ugcShipping) / nbCreateurs : 0;

  // ── Produits offerts hors Creator (événements, cafés non-Creator, etc.) ──────
  let giftsComps: Comps = { ...ZERO };
  let cogsGifts = 0;
  for (const p of produitsOfferts) {
    giftsComps = add(giftsComps, produitTypeToComps(p.produit, p.quantite));
    cogsGifts += p.coutTotal;
  }

  // ── Dépenses depuis DB ───────────────────────────────────────────────────────
  const adsBudget           = expenses.filter(e => e.category === "Meta Ads" || e.category === "Publicité Meta").reduce((s, e) => s + e.amount, 0);
  const totalExpenses       = expenses.reduce((s, e) => s + e.amount, 0);
  const totalExpensesNonAds = totalExpenses - adsBudget;
  const expensesByCategory  = Object.entries(
    expenses.filter(e => e.category !== "Meta Ads" && e.category !== "Publicité Meta").reduce((acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + e.amount;
      return acc;
    }, {} as Record<string, number>)
  ).map(([category, total]) => ({ category, total }));

  // ── P&L ──────────────────────────────────────────────────────────────────────
  const ca             = shopify.revenue;
  const nbCommandes    = shopify.orderCount;   // toutes commandes (affichage)
  const paidCount      = shopify.paidCount;    // hors remboursées (diviseur métriques)
  const panierMoyen    = paidCount > 0 ? ca / paidCount : 0;
  const cogsSales      = shopify.cogsSales;
  const cogsTotal      = cogsSales + ugcCogs + cogsGifts;
  const livraison      = shopify.shipping;
  const coutsVariables = cogsTotal + livraison + ugcShipping;
  const totalHorsAds   = coutsVariables + totalExpensesNonAds;

  const resultatBusiness = ca - totalHorsAds;
  const margeBusiness    = ca > 0 ? (resultatBusiness / ca) * 100 : 0;
  const totalDepense     = totalHorsAds + adsBudget;
  const resultatGlobal   = ca - totalDepense;
  const margeGlobale     = ca > 0 ? (resultatGlobal / ca) * 100 : 0;
  const coutParCommande  = paidCount > 0 ? totalDepense / paidCount : 0;
  const profitParCmd     = paidCount > 0 ? resultatGlobal / paidCount : 0;

  const margeVarParCmd = paidCount > 0 ? resultatBusiness / paidCount : 0;
  const seuilAds       = margeVarParCmd > 0 && adsBudget > 0 ? Math.ceil(adsBudget / margeVarParCmd) : 0;
  const roas           = adsBudget > 0 ? ca / adsBudget : 0;
  const profitAds      = ca - adsBudget;

  // ── Stock par composant (ventes + UGC + autres offerts) ───────────────────────
  type StockStat = { init: number; vendus: number; offerts: number; total: number; restant: number; pct: number; };
  function mkStat(init: number, vendus: number, offerts: number): StockStat {
    const total   = vendus + offerts;
    const restant = Math.max(0, init - total);
    return { init, vendus, offerts, total, restant, pct: init > 0 ? (total / init) * 100 : 0 };
  }

  const allOfferts = add(ugcComps, giftsComps);
  const stock = {
    pots:     mkStat(STOCK_INIT.pots,     shopify.salesComps.pots,     allOfferts.pots),
    fouets:   mkStat(STOCK_INIT.fouets,   shopify.salesComps.fouets,   allOfferts.fouets),
    bols:     mkStat(STOCK_INIT.bols,     shopify.salesComps.bols,     allOfferts.bols),
    cuilleres:mkStat(STOCK_INIT.cuilleres,shopify.salesComps.cuilleres,allOfferts.cuilleres),
  };

  const stockTotalAchete   = cogs({ pots: STOCK_INIT.pots, fouets: STOCK_INIT.fouets, bols: STOCK_INIT.bols, cuilleres: STOCK_INIT.cuilleres });
  const stockRestantValeur = stock.pots.restant * COUT.pot + stock.fouets.restant * COUT.fouet + stock.bols.restant * COUT.bol;
  const stockMortValeur    = stock.cuilleres.restant * COUT.cuillere;

  return {
    ca, nbCommandes, panierMoyen,
    cogsSales, ugcCogs, cogsGifts, cogsTotal, livraison, ugcShipping, coutsVariables,
    expensesByCategory, totalExpensesNonAds, adsBudget, roas, profitAds, seuilAds,
    totalHorsAds, resultatBusiness, margeBusiness,
    totalDepense, resultatGlobal, margeGlobale, coutParCommande, profitParCmd,
    stock, stockTotalAchete, stockRestantValeur, stockMortValeur,
    nbCreateurs, nbByShipping, nbByContent, nbContents, ugcCoutMoyen,
    ugcComps,
    creators,
    expenses,
    orderBreakdowns: shopify.orderBreakdowns,
    scopeError: shopify.scopeError,
  };
};

// ─── Action — gestion des charges ─────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "expense_create") {
    await prisma.expense.create({
      data: {
        label:    form.get("label") as string,
        amount:   parseFloat(form.get("amount") as string),
        category: form.get("category") as string,
        date:     new Date(form.get("date") as string),
        type:     "ponctuelle",
        note:     (form.get("note") as string) || null,
      },
    });
    return { ok: true };
  }

  if (intent === "expense_update") {
    await prisma.expense.update({
      where: { id: form.get("id") as string },
      data: {
        label:    form.get("label") as string,
        amount:   parseFloat(form.get("amount") as string),
        category: form.get("category") as string,
        date:     new Date(form.get("date") as string),
        note:     (form.get("note") as string) || null,
      },
    });
    return { ok: true };
  }

  if (intent === "expense_delete") {
    await prisma.expense.delete({ where: { id: form.get("id") as string } });
    return { ok: true };
  }

  return { ok: false };
};

// ─── Formatage ────────────────────────────────────────────────────────────────

function eur(n: number) {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function pct(n: number) { return n.toFixed(1) + " %"; }

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", dim: "#94a3b8", accent: "#6366f1",
  green: "#059669", greenBg: "#f0fdf4", greenBdr: "#86efac",
  orange: "#d97706", orangeBg: "#fffbeb", orangeBdr: "#fde68a",
  red: "#dc2626", redBg: "#fef2f2", redBdr: "#fca5a5",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
} as const;

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  .dw { padding: 36px 40px 60px; overflow-x: hidden; }
  .g3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .g4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .g2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .hv { font-size: 38px; }
  @media (max-width: 640px) {
    .dw { padding: 16px 14px 48px; }
    .g3, .g4, .g2 { grid-template-columns: 1fr; gap: 10px; }
    .hv { font-size: 30px; }
  }
  @media (min-width: 641px) and (max-width: 900px) {
    .dw { padding: 24px 20px 48px; }
    .g3, .g4 { grid-template-columns: repeat(2, 1fr); }
    .hv { font-size: 32px; }
  }
`;

// ─── UI Components ────────────────────────────────────────────────────────────

function SectionLabel({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <span style={{ width: 3, height: 16, borderRadius: 99, background: accent ?? T.accent, flexShrink: 0, display: "block" }} />
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: T.muted }}>
        {children}
      </span>
    </div>
  );
}

interface MCardProps {
  label: string; value: string; sub?: string | null;
  color?: string; bg?: string; bdr?: string; accentTop?: boolean;
}
function MCard({ label, value, sub, color, bg, bdr, accentTop }: MCardProps) {
  return (
    <div style={{ background: bg ?? T.card, border: `1px solid ${bdr ?? T.border}`, borderTop: accentTop ? `3px solid ${T.accent}` : undefined, borderRadius: 14, padding: "16px 18px 14px", display: "flex", flexDirection: "column", gap: 4, boxShadow: T.shadow, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, color: color ?? T.text, fontVariantNumeric: "tabular-nums", wordBreak: "break-word" }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{sub}</span>}
    </div>
  );
}

interface HCardProps { label: string; value: number; forceColor?: "green" | "red" | "orange"; sub?: string; }
function HCard({ label, value, forceColor, sub }: HCardProps) {
  const auto  = value < 0 ? "red" : "green";
  const which = forceColor ?? auto;
  const color = which === "red" ? T.red : which === "orange" ? T.orange : T.green;
  const bg    = which === "red" ? T.redBg : which === "orange" ? T.orangeBg : T.greenBg;
  const bdr   = which === "red" ? T.redBdr : which === "orange" ? T.orangeBdr : T.greenBdr;
  return (
    <div style={{ background: bg, border: `2px solid ${bdr}`, borderRadius: 18, padding: "20px 20px 18px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.08)", minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color, opacity: 0.75 }}>{label}</span>
      <span className="hv" style={{ fontWeight: 800, lineHeight: 1.1, color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", wordBreak: "break-word" }}>{eur(value)}</span>
      {sub && <span style={{ fontSize: 13, color, opacity: 0.75, marginTop: 2 }}>{sub}</span>}
    </div>
  );
}

const HR = () => <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />;

// ─── Expenses Manager ─────────────────────────────────────────────────────────

const EXPENSE_CATEGORIES = [
  "Packaging", "Shopify", "Graphiste", "Événements",
  "Meta Ads", "UGC / Influence", "Transport", "Logistique", "Marketing", "Autre",
] as const;

const isAdsCategory = (c: string) => c === "Meta Ads" || c === "Publicité Meta";

type ExpenseRow = { id: string; date: Date | string; category: string; label: string; amount: number; type: string; note: string | null };

const inputSt: React.CSSProperties = {
  border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 13,
  fontFamily: "inherit", color: T.text, background: "#fff", width: "100%", outline: "none",
};
const btnPri: React.CSSProperties = {
  background: T.accent, color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px",
  fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
};
const btnSec: React.CSSProperties = {
  background: "#f1f5f9", color: T.muted, border: `1px solid ${T.border}`, borderRadius: 8,
  padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
};
const btnDanger: React.CSSProperties = {
  background: T.redBg, color: T.red, border: `1px solid ${T.redBdr}`, borderRadius: 8,
  padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
};

function ExpenseForm({
  expense, onCancel, fetcher,
}: {
  expense?: ExpenseRow;
  onCancel: () => void;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const busy = fetcher.state !== "idle";
  const defaultDate = expense
    ? new Date(expense.date).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  return (
    <fetcher.Form method="post" style={{ display: "contents" }}>
      <input type="hidden" name="intent" value={expense ? "expense_update" : "expense_create"} />
      {expense && <input type="hidden" name="id" value={expense.id} />}
      <tr style={{ background: "#eef2ff" }}>
        <td style={{ padding: "8px 14px" }}>
          <input name="label" defaultValue={expense?.label} placeholder="Intitulé" required style={inputSt} />
        </td>
        <td style={{ padding: "8px 8px" }}>
          <select name="category" defaultValue={expense?.category ?? "Autre"} style={inputSt}>
            {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </td>
        <td style={{ padding: "8px 8px" }}>
          <input name="date" type="date" defaultValue={defaultDate} required style={inputSt} />
        </td>
        <td style={{ padding: "8px 8px" }}>
          <input name="amount" type="number" step="0.01" min="0" defaultValue={expense?.amount} placeholder="€" required style={{ ...inputSt, textAlign: "right" }} />
        </td>
        <td style={{ padding: "8px 14px" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="submit" disabled={busy} style={btnPri}>{busy ? "…" : expense ? "Sauver" : "Ajouter"}</button>
            <button type="button" onClick={onCancel} style={btnSec}>✕</button>
          </div>
        </td>
      </tr>
    </fetcher.Form>
  );
}

function ExpensesManager({ expenses }: { expenses: ExpenseRow[] }) {
  const fetcher = useFetcher();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      setShowAdd(false);
      setEditingId(null);
    }
  }, [fetcher.state, fetcher.data]);

  const nonAds = expenses.filter(e => e.category !== "Publicité Meta");
  const ads    = expenses.filter(e => e.category === "Publicité Meta");

  const byCategory = Object.entries(
    expenses.reduce((acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + e.amount;
      return acc;
    }, {} as Record<string, number>)
  ).sort((a, b) => b[1] - a[1]);

  const total = expenses.reduce((s, e) => s + e.amount, 0);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden", boxShadow: T.shadow, marginBottom: 14 }}>
      {/* ── En-tête avec total + bouton ajouter ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#f8fafc", borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
          {expenses.length} charge{expenses.length !== 1 ? "s" : ""} · total{" "}
          <span style={{ color: T.red }}>{eur(total)}</span>
        </span>
        {!showAdd && !editingId && (
          <button onClick={() => setShowAdd(true)} style={btnPri}>+ Ajouter une charge</button>
        )}
      </div>

      {/* ── Table des charges ── */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f1f5f9" }}>
              <th style={{ padding: "8px 14px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>Intitulé</th>
              <th style={{ padding: "8px 8px",  textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>Catégorie</th>
              <th style={{ padding: "8px 8px",  textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>Date</th>
              <th style={{ padding: "8px 8px",  textAlign: "right",fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>Montant</th>
              <th style={{ padding: "8px 14px", borderBottom: `1px solid ${T.border}`, width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {expenses.length === 0 && !showAdd && (
              <tr>
                <td colSpan={5} style={{ padding: "20px 16px", textAlign: "center", color: T.muted, fontSize: 12 }}>
                  Aucune charge enregistrée — cliquez sur « + Ajouter une charge »
                </td>
              </tr>
            )}
            {expenses.map((e, i) =>
              editingId === e.id ? (
                <ExpenseForm key={e.id} expense={e} onCancel={() => setEditingId(null)} fetcher={fetcher} />
              ) : (
                <tr key={e.id} style={{ borderTop: i > 0 ? `1px solid ${T.border}` : undefined, background: isAdsCategory(e.category) ? "#fffbeb" : i % 2 === 0 ? "#fff" : "#fafafa" }}>
                  <td style={{ padding: "9px 14px", fontWeight: 500, color: T.text }}>{e.label}</td>
                  <td style={{ padding: "9px 8px" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: isAdsCategory(e.category) ? T.orangeBg : "#f1f5f9", color: isAdsCategory(e.category) ? T.orange : T.muted }}>
                      {e.category}
                    </span>
                  </td>
                  <td style={{ padding: "9px 8px", color: T.dim, fontSize: 12 }}>
                    {new Date(e.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                  </td>
                  <td style={{ padding: "9px 8px", textAlign: "right", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(e.amount)}</td>
                  <td style={{ padding: "9px 14px" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={() => { setEditingId(e.id); setShowAdd(false); }} style={btnSec}>✏️</button>
                      <fetcher.Form method="post" style={{ display: "contents" }}>
                        <input type="hidden" name="intent" value="expense_delete" />
                        <input type="hidden" name="id" value={e.id} />
                        <button type="submit" style={btnDanger} onClick={ev => { if (!confirm(`Supprimer « ${e.label} » ?`)) ev.preventDefault(); }}>🗑</button>
                      </fetcher.Form>
                    </div>
                  </td>
                </tr>
              )
            )}
            {showAdd && (
              <ExpenseForm onCancel={() => setShowAdd(false)} fetcher={fetcher} />
            )}
          </tbody>
        </table>
      </div>

      {/* ── Résumé par catégorie ── */}
      {expenses.length > 0 && (
        <div style={{ borderTop: `2px solid ${T.border}`, background: "#f8fafc" }}>
          <div style={{ padding: "10px 16px 4px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim }}>
            Répartition par catégorie
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 16px 14px" }}>
            {byCategory.map(([cat, tot]) => (
              <span key={cat} style={{
                fontSize: 12, fontWeight: 600, padding: "4px 12px", borderRadius: 99,
                background: isAdsCategory(cat) ? T.orangeBg : T.redBg,
                color: isAdsCategory(cat) ? T.orange : T.red,
                border: `1px solid ${isAdsCategory(cat) ? T.orangeBdr : T.redBdr}`,
              }}>
                {cat} · {eur(tot)}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 16px", borderTop: `1px solid ${T.border}` }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Total général</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();

  const businessAlert: "green" | "orange" | "red" = d.resultatBusiness < 0 ? "red" : d.margeBusiness < 10 ? "orange" : "green";
  const globalAlert: "green" | "orange" | "red"   = d.resultatGlobal < 0 ? "red" : d.margeGlobale < 10 ? "orange" : "green";

  return (
    <>
      <style>{CSS}</style>
      <div className="dw" style={{ minHeight: "100vh", background: T.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>

          {d.scopeError && (
            <div style={{ background: T.orangeBg, border: `1px solid ${T.orange}`, borderRadius: 10, padding: "12px 16px", marginBottom: 24, fontSize: 13, color: "#92400e" }}>
              Scope insuffisant — ajoutez <strong>read_orders</strong> dans les scopes et réinstallez l'app.
            </div>
          )}

          {/* ── Header ── */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32, flexWrap: "wrap", gap: 8 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text, letterSpacing: "-0.02em" }}>Dashboard Laya</h1>
              <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>Données en temps réel · {d.nbCommandes} commandes · CA {eur(d.ca)}</p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => window.location.reload()}
                style={{ fontSize: 11, color: T.accent, background: "#eef2ff", padding: "4px 10px", borderRadius: 99, border: "1px solid #c7d2fe", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                ↺ Rafraîchir
              </button>
              <a href="/app/ugc" style={{ fontSize: 11, color: T.accent, background: "#eef2ff", padding: "4px 10px", borderRadius: 99, border: "1px solid #c7d2fe", textDecoration: "none" }}>
                UGC →
              </a>
              <a href="/app/produits-offerts" style={{ fontSize: 11, color: T.muted, background: "#f8fafc", padding: "4px 10px", borderRadius: 99, border: `1px solid ${T.border}`, textDecoration: "none" }}>
                Produits offerts →
              </a>
            </div>
          </div>

          {/* ══ BLOC 1 — RÉSULTAT BUSINESS (HORS ADS) ════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Résultat business — hors ads</SectionLabel>

            <div className="g3" style={{ marginBottom: 14 }}>
              <HCard label="Chiffre d'affaires" value={d.ca} forceColor="green"
                sub={`${d.nbCommandes} commandes · panier ${eur(d.panierMoyen)}`} />
              <HCard label="Coûts hors ads" value={d.totalHorsAds} forceColor="red"
                sub={`Variables ${eur(d.coutsVariables)} + dépenses ${eur(d.totalExpensesNonAds)}`} />
              <HCard label="Résultat business" value={d.resultatBusiness} forceColor={businessAlert}
                sub={`Marge : ${pct(d.margeBusiness)}`} />
            </div>

            {/* Coûts variables */}
            <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 600, color: T.dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Coûts variables
            </div>
            <div className="g4" style={{ marginBottom: 16 }}>
              <MCard label="COGS — ventes Shopify" value={eur(d.cogsSales)}
                sub={`${((d.cogsSales / Math.max(d.ca, 1)) * 100).toFixed(1)} % du CA`} color={T.red} />
              <MCard label="COGS — UGC & collabs" value={eur(d.ugcCogs)}
                sub={`${d.nbCreateurs} créateurs · produits envoyés`} color={T.red} />
              <MCard label="COGS — autres offerts" value={eur(d.cogsGifts)}
                sub={d.cogsGifts > 0 ? "Événements, démos" : "Aucun enregistré"}
                color={d.cogsGifts > 0 ? T.red : T.muted} />
              <MCard label="Livraison commandes" value={eur(d.livraison)}
                sub={`${((d.livraison / Math.max(d.ca, 1)) * 100).toFixed(1)} % du CA`} color={T.red} />
            </div>

            {/* Dépenses — gestionnaire inline */}
            <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 600, color: T.dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Charges fixes &amp; dépenses
            </div>
            <ExpensesManager expenses={d.expenses} />

            <div className="g3">
              <MCard label="Panier moyen" value={eur(d.panierMoyen)} sub="par commande" />
              <MCard label="Profit / commande" value={eur(d.profitParCmd)}
                sub="résultat global ÷ commandes"
                color={d.profitParCmd < 0 ? T.red : T.green} />
              <MCard label="Marge business" value={pct(d.margeBusiness)}
                color={d.margeBusiness < 0 ? T.red : d.margeBusiness < 10 ? T.orange : T.green} />
            </div>
          </section>

          <HR />

          {/* ══ BLOC 2 — ADS ══════════════════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel accent={T.orange}>Marketing Ads — Meta</SectionLabel>

            {d.adsBudget === 0 ? (
              <div style={{ background: T.orangeBg, border: `2px dashed ${T.orangeBdr}`, borderRadius: 16, padding: "28px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
                <div style={{ fontWeight: 700, fontSize: 15, color: T.orange, marginBottom: 6 }}>Aucune dépense Meta Ads enregistrée</div>
                <div style={{ fontSize: 13, color: T.muted, maxWidth: 400, margin: "0 auto" }}>
                  Ajoute une charge avec la catégorie <strong>Meta Ads</strong> dans la section Charges ci-dessus pour voir ton ROAS, ta rentabilité et ton seuil de break-even.
                </div>
              </div>
            ) : (
              <>
                <div className="g3" style={{ marginBottom: 14 }}>
                  {/* Budget */}
                  <HCard label="Budget Meta Ads" value={d.adsBudget} forceColor="red"
                    sub={`${d.expenses.filter(e => isAdsCategory(e.category)).length} campagne${d.expenses.filter(e => isAdsCategory(e.category)).length > 1 ? "s" : ""}`} />

                  {/* ROAS */}
                  {(() => {
                    const roasColor = d.roas >= 3 ? T.green : d.roas >= 1 ? T.orange : T.red;
                    const roasBg    = d.roas >= 3 ? T.greenBg : d.roas >= 1 ? T.orangeBg : T.redBg;
                    const roasBdr   = d.roas >= 3 ? T.greenBdr : d.roas >= 1 ? T.orangeBdr : T.redBdr;
                    const roasLabel = d.roas >= 3 ? "Bon ROAS" : d.roas >= 1 ? "ROAS faible" : "ROAS négatif";
                    return (
                      <div style={{ background: roasBg, border: `2px solid ${roasBdr}`, borderRadius: 18, padding: "20px 20px 18px", display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: roasColor, opacity: 0.75 }}>ROAS réel</span>
                        <span className="hv" style={{ fontWeight: 800, lineHeight: 1.1, color: roasColor, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>×{d.roas.toFixed(2)}</span>
                        <span style={{ fontSize: 13, color: roasColor, opacity: 0.75 }}>{roasLabel} · {eur(d.ca)} CA / {eur(d.adsBudget)} dépensés</span>
                      </div>
                    );
                  })()}

                  {/* Résultat net ads */}
                  <HCard
                    label={d.profitAds >= 0 ? "Profit ads net" : "Perte ads nette"}
                    value={d.profitAds}
                    sub={`CA ${eur(d.ca)} − budget ${eur(d.adsBudget)}`}
                  />
                </div>

                <div className="g3">
                  <MCard label="Seuil rentabilité ads" value={d.seuilAds > 0 ? `${d.seuilAds} cmd` : "—"}
                    sub={d.seuilAds > 0 ? `${Math.max(0, d.seuilAds - d.nbCommandes)} cmd supplémentaires` : undefined}
                    color={T.orange} />
                  <MCard label="Coût ads / commande" value={eur(d.adsBudget / Math.max(d.nbCommandes, 1))}
                    sub="si attribuées à toutes les commandes" color={T.red} />
                  <MCard label="Marge nette (après ads)" value={pct(d.margeGlobale)}
                    color={d.margeGlobale < 0 ? T.red : d.margeGlobale < 10 ? T.orange : T.green}
                    sub={`Résultat global ${eur(d.resultatGlobal)}`} />
                </div>
              </>
            )}
          </section>

          <HR />

          {/* ══ BLOC 3 — RÉSULTAT GLOBAL ══════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Résultat global — toutes charges</SectionLabel>

            <div className="g3" style={{ marginBottom: 14 }}>
              <HCard label="Chiffre d'affaires" value={d.ca} forceColor="green"
                sub={`${d.nbCommandes} commandes`} />
              <HCard label="Total dépensé" value={d.totalDepense} forceColor="red"
                sub={`${eur(d.coutParCommande)} / commande`} />
              <HCard label="Résultat global" value={d.resultatGlobal} forceColor={globalAlert}
                sub={`Marge nette : ${pct(d.margeGlobale)}`} />
            </div>

            <div className="g4">
              <MCard label="COGS (ventes)" value={eur(d.cogsSales)} color={T.red} />
              <MCard label="Produits offerts" value={eur(d.cogsGifts)} color={T.red} />
              <MCard label="Livraison" value={eur(d.livraison)} color={T.red} />
              <MCard label="Ads Meta" value={eur(d.adsBudget)} color={T.red} accentTop />
            </div>
          </section>

          <HR />

          {/* ══ STOCK PAR COMPOSANT ══════════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Stock par composant</SectionLabel>

            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow, marginBottom: 16 }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9" }}>
                      {["Composant", "Coût unit.", "Initial", "Vendus", "Offerts", "Consommés", "Restants", "% éco.", ""].map(h => (
                        <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(["pots", "fouets", "bols", "cuilleres"] as const).map((k, i) => {
                      const s = d.stock[k];
                      const labels = { pots: "Pots", fouets: "Fouets", bols: "Bols", cuilleres: "Cuillères" };
                      const couts  = { pots: COUT.pot, fouets: COUT.fouet, bols: COUT.bol, cuilleres: COUT.cuillere };
                      const isMort = k === "cuilleres";
                      const color  = s.pct > 80 ? T.red : s.pct > 50 ? T.orange : T.green;
                      return (
                        <tr key={k} style={{ borderTop: i > 0 ? `1px solid ${T.border}` : undefined }}>
                          <td style={{ padding: "10px 14px", fontWeight: 600, color: T.text }}>{labels[k]}</td>
                          <td style={{ padding: "10px 14px", color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(couts[k])}</td>
                          <td style={{ padding: "10px 14px", color: T.muted, textAlign: "right" }}>{s.init}</td>
                          <td style={{ padding: "10px 14px", color: T.red, textAlign: "right", fontWeight: 500 }}>{s.vendus}</td>
                          <td style={{ padding: "10px 14px", color: T.orange, textAlign: "right", fontWeight: 500 }}>{s.offerts}</td>
                          <td style={{ padding: "10px 14px", color: T.text, textAlign: "right", fontWeight: 700 }}>{s.total}</td>
                          <td style={{ padding: "10px 14px", color: isMort ? T.red : T.green, textAlign: "right", fontWeight: 600 }}>{s.restant}</td>
                          <td style={{ padding: "10px 14px", textAlign: "right" }}>
                            <span style={{ background: color + "1a", color, fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>
                              {s.pct.toFixed(0)} %
                            </span>
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            {isMort && s.restant > 0 && (
                              <span style={{ background: T.redBg, color: T.red, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, whiteSpace: "nowrap" }}>
                                STOCK MORT
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Stock restant & mort */}
            <div className="g3">
              <MCard label="Stock initial acheté" value={eur(d.stockTotalAchete)}
                sub="200 pots + 100 fouets + 100 bols + 100 cuillères" />
              <MCard label="Stock utilisable restant" value={eur(d.stockRestantValeur)}
                sub="pots + fouets + bols restants (hors cuillères)" color={T.green} />
              <MCard label="Stock mort (cuillères)" value={eur(d.stockMortValeur)}
                sub={`${d.stock.cuilleres.restant} cuillères non vendables — perte irréversible`}
                color={T.red} bg={T.redBg} bdr={T.redBdr} />
            </div>
          </section>

          <HR />

          {/* ══ PRESSION STOCK ═══════════════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Pression stock</SectionLabel>
            <div className="g3">
              {(["pots", "fouets", "bols"] as const).map(k => {
                const s = d.stock[k];
                const labels = { pots: "Pots", fouets: "Fouets", bols: "Bols" };
                const bar = Math.min(100, s.pct);
                const barColor = s.pct > 80 ? T.red : s.pct > 50 ? T.orange : T.green;
                return (
                  <div key={k} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 18px", boxShadow: T.shadow }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim }}>{labels[k]}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: barColor }}>{s.pct.toFixed(0)} %</span>
                    </div>
                    <div style={{ height: 8, background: "#e2e8f0", borderRadius: 99, overflow: "hidden", marginBottom: 6 }}>
                      <div style={{ height: "100%", width: `${bar}%`, background: barColor, borderRadius: 99, transition: "width 0.3s" }} />
                    </div>
                    <div style={{ fontSize: 12, color: T.muted }}>{s.total} / {s.init} utilisés · {s.restant} restants</div>
                  </div>
                );
              })}
            </div>
          </section>

          <HR />

          {/* ══ VÉRIFICATION COGS ════════════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Vérification COGS — détail par commande</SectionLabel>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["Commande", "Pays", "Statut paiement", "Produit", "Qté", "Composants", "COGS", "Livraison", "CA"].map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.orderBreakdowns.map((order, oi) => {
                    const rowBg = (idx: number) => order.isRefunded ? "#fef2f2" : idx === 0 && oi % 2 === 0 ? "#fff" : idx === 0 ? "#f8fafc" : "transparent";
                    const statusBadge = (
                      order.isRefunded
                        ? <span style={{ background: T.redBg, color: T.red, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, whiteSpace: "nowrap" }}>Remboursée</span>
                        : order.displayFinancialStatus === "PARTIALLY_REFUNDED"
                          ? <span style={{ background: T.orangeBg, color: T.orange, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, whiteSpace: "nowrap" }}>Part. remboursée</span>
                          : <span style={{ background: T.greenBg, color: T.green, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, whiteSpace: "nowrap" }}>Payée</span>
                    );

                    // Commande sans line items reconnus : afficher quand même la ligne
                    if (order.items.length === 0) {
                      return (
                        <tr key={`${oi}-empty`} style={{ background: rowBg(0), borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.accent, whiteSpace: "nowrap" }}>{order.name}</td>
                          <td style={{ padding: "8px 10px", color: T.muted }}>{order.country}</td>
                          <td style={{ padding: "8px 10px" }}>{statusBadge}</td>
                          <td colSpan={4} style={{ padding: "8px 10px", color: T.dim, fontSize: 11 }}>— aucun article détecté</td>
                          <td style={{ padding: "8px 10px", color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(order.shipping)}</td>
                          <td style={{ padding: "8px 10px", fontWeight: 600, color: order.isRefunded ? T.red : T.green, fontVariantNumeric: "tabular-nums" }}>{eur(order.revenue)}</td>
                        </tr>
                      );
                    }

                    return order.items.map((item, ii) => {
                      const isKit = item.comps.fouets > 0;
                      const isUnknown = item.comps.pots === 0 && item.comps.fouets === 0 && item.comps.bols === 0 && item.comps.cuilleres === 0;
                      return (
                        <tr key={`${oi}-${ii}`} style={{ background: rowBg(ii), borderTop: ii === 0 ? `1px solid ${T.border}` : undefined }}>
                          {ii === 0 && (
                            <>
                              <td rowSpan={order.items.length} style={{ padding: "8px 10px", fontWeight: 700, color: T.accent, whiteSpace: "nowrap", verticalAlign: "top" }}>{order.name}</td>
                              <td rowSpan={order.items.length} style={{ padding: "8px 10px", color: T.muted, verticalAlign: "top" }}>{order.country}</td>
                              <td rowSpan={order.items.length} style={{ padding: "8px 10px", verticalAlign: "top" }}>{statusBadge}</td>
                            </>
                          )}
                          <td style={{ padding: "6px 10px", color: T.text, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</td>
                          <td style={{ padding: "6px 10px", color: T.muted, textAlign: "center" }}>{item.qty}</td>
                          <td style={{ padding: "6px 10px" }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 99, background: isUnknown ? T.redBg : isKit ? "#eef2ff" : "#f0fdf4", color: isUnknown ? T.red : isKit ? T.accent : T.green }}>
                              {fmtComps(item.comps)}
                            </span>
                          </td>
                          <td style={{ padding: "6px 10px", fontWeight: 600, color: T.red, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{eur(item.itemCogs)}</td>
                          {ii === 0 && (
                            <>
                              <td rowSpan={order.items.length} style={{ padding: "8px 10px", color: T.muted, whiteSpace: "nowrap", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{eur(order.shipping)}</td>
                              <td rowSpan={order.items.length} style={{ padding: "8px 10px", fontWeight: 600, color: order.isRefunded ? T.red : T.green, whiteSpace: "nowrap", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{eur(order.revenue)}</td>
                            </>
                          )}
                        </tr>
                      );
                    });
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                    <td colSpan={6} style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total (hors remboursées)</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(d.cogsSales)}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(d.livraison)}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: T.green, fontVariantNumeric: "tabular-nums" }}>{eur(d.ca)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <HR />

          {/* ══ UGC ══════════════════════════════════════════════════════════ */}
          <section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <SectionLabel>UGC & Collabs</SectionLabel>
              <a href="/app/ugc" style={{ fontSize: 11, color: T.accent, background: "#eef2ff", padding: "4px 10px", borderRadius: 99, border: "1px solid #c7d2fe", textDecoration: "none" }}>
                Gérer →
              </a>
            </div>

            {/* KPIs */}
            <div className="g4" style={{ marginBottom: 12 }}>
              <MCard label="Créateurs" value={String(d.nbCreateurs)} sub="UGC + influence + café" />
              <MCard label="Colis livrés" value={String(d.nbByShipping["livre"] ?? 0)} sub="shippingStatus = livré" color={T.green} />
              <MCard label="Coût total UGC" value={eur(d.ugcCogs + d.ugcShipping)}
                sub={`produits ${eur(d.ugcCogs)} + port ${eur(d.ugcShipping)}`} color={T.red} />
              <MCard label="Coût moyen / créateur" value={eur(d.ugcCoutMoyen)}
                sub="produit + livraison" color={T.orange} />
            </div>

            {/* Pipeline double */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "13px 18px", boxShadow: T.shadow }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: T.dim, letterSpacing: "0.08em", marginBottom: 9 }}>Pipeline colis</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {(["en_attente","preparation","envoye","livre"] as const).map((s, idx, arr) => (
                    <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ ...shippingStyle(s), borderRadius: 99, padding: "3px 11px", fontSize: 11, fontWeight: 700, display: "inline-block" }}>
                          {d.nbByShipping[s] ?? 0}
                        </div>
                        <div style={{ fontSize: 10, color: T.dim, marginTop: 2 }}>{SHIPPING_LABELS[s]}</div>
                      </div>
                      {idx < arr.length - 1 && <span style={{ color: T.dim, fontSize: 13, marginBottom: 14 }}>→</span>}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "13px 18px", boxShadow: T.shadow }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: T.dim, letterSpacing: "0.08em", marginBottom: 9 }}>Pipeline contenu</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {(["a_faire","recu","poste"] as const).map((s, idx, arr) => (
                    <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ ...contentStyle(s), borderRadius: 99, padding: "3px 11px", fontSize: 11, fontWeight: 700, display: "inline-block" }}>
                          {d.nbByContent[s] ?? 0}
                        </div>
                        <div style={{ fontSize: 10, color: T.dim, marginTop: 2 }}>{CONTENT_LABELS[s]}</div>
                      </div>
                      {idx < arr.length - 1 && <span style={{ color: T.dim, fontSize: 13, marginBottom: 14 }}>→</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Composants offerts via UGC */}
            <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 600, color: T.dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Stock consommé par UGC
            </div>
            <div className="g4" style={{ marginBottom: 16 }}>
              <MCard label="Pots offerts UGC" value={String(d.ugcComps.pots)}
                sub={`${eur(d.ugcComps.pots * 3.77055)} COGS`} color={T.red} />
              <MCard label="Fouets offerts UGC" value={String(d.ugcComps.fouets)}
                sub={`${eur(d.ugcComps.fouets * 4.1806)} COGS`} color={T.red} />
              <MCard label="Bols offerts UGC" value={String(d.ugcComps.bols)}
                sub={`${eur(d.ugcComps.bols * 4.1806)} COGS`} color={T.red} />
              <MCard label="Cuillères offertes UGC" value={String(d.ugcComps.cuilleres)}
                sub={d.ugcComps.cuilleres > 0 ? `${eur(d.ugcComps.cuilleres * 2.40)} · stock mort` : "Aucune"}
                color={d.ugcComps.cuilleres > 0 ? T.red : T.muted} />
            </div>

            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9" }}>
                      {["Nom", "Type", "Pays", "Produit", "Port", "COGS", "Total", "Colis", "Contenu"].map(h => (
                        <th key={h} style={{ padding: "9px 12px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.creators.map((c, i) => {
                      const { color: shipColor, background: shipBg } = shippingStyle(c.shippingStatus);
                      const { color: contColor, background: contBg } = contentStyle(c.contentStatus);
                      const typeLabel = { ugc: "UGC", influence: "Influence", cafe: "Café", autre: "Autre" }[c.type ?? ""] ?? c.type ?? "—";
                      return (
                        <tr key={c.id} style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                          <td style={{ padding: "8px 12px", fontWeight: 600, color: T.text }}>{c.nom}</td>
                          <td style={{ padding: "8px 12px" }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 99, background: "#eef2ff", color: T.accent }}>{typeLabel}</span>
                          </td>
                          <td style={{ padding: "8px 12px", color: T.muted }}>{c.pays}</td>
                          <td style={{ padding: "8px 12px", color: T.text, fontSize: 11 }}>{c.produit.replace(/_/g, " ")}</td>
                          <td style={{ padding: "8px 12px", color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(c.fraisPort)}</td>
                          <td style={{ padding: "8px 12px", color: T.red, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{eur(c.coutProduit ?? 0)}</td>
                          <td style={{ padding: "8px 12px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(c.coutTotalCollab ?? 0)}</td>
                          <td style={{ padding: "8px 12px" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: shipBg, color: shipColor }}>{SHIPPING_LABELS[c.shippingStatus] ?? c.shippingStatus}</span>
                          </td>
                          <td style={{ padding: "8px 12px" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: contBg, color: contColor }}>{CONTENT_LABELS[c.contentStatus] ?? c.contentStatus}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                      <td colSpan={4} style={{ padding: "9px 12px", fontWeight: 700, color: T.text }}>Total</td>
                      <td style={{ padding: "9px 12px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(d.ugcShipping)}</td>
                      <td style={{ padding: "9px 12px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(d.ugcCogs)}</td>
                      <td style={{ padding: "9px 12px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(d.ugcCogs + d.ugcShipping)}</td>
                      <td /><td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </section>

        </div>
      </div>
    </>
  );
}

// Expose COUT for use in produits-offerts route
export { COUT };
