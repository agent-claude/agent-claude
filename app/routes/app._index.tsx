import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

async function safeAggregate<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

type AdminClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const ORDERS_QUERY = `
  query GetOrders {
    orders(first: 50, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          currentTotalPriceSet { shopMoney { amount } }
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
  id?: string;
  currentTotalPriceSet?: { shopMoney?: { amount?: string } };
  shippingAddress?: { countryCode?: string };
  lineItems?: { edges: { node: { title?: string; quantity?: number } }[] };
}

// ── Coûts unitaires réels (facture CMD-001) ───────────────────────────────────
const POT_COST      = 3.77055;
const BOL_COST      = 4.1806;
const FOUET_COST    = 4.1806;
const CUILLERE_COST = 2.40;

function getProductCost(order: OrderNode): number {
  let cost = 0;
  for (const { node } of order.lineItems?.edges ?? []) {
    const title = (node.title ?? "").toLowerCase();
    const qty   = node.quantity ?? 1;
    if (title.includes("kit ultime"))
      cost += qty * (3 * POT_COST + BOL_COST + FOUET_COST + CUILLERE_COST);
    else if (title.includes("kit découverte") || title.includes("kit decouverte"))
      cost += qty * (2 * POT_COST + FOUET_COST);
    else
      cost += qty * POT_COST;
  }
  return cost;
}

function getShippingCost(order: OrderNode): number {
  const country = (order.shippingAddress?.countryCode ?? "").toUpperCase();
  const items   = order.lineItems?.edges ?? [];
  const isKitUltime     = items.some(({ node }) => node.title?.toLowerCase().includes("kit ultime"));
  const isKitDecouverte = items.some(({ node }) =>
    node.title?.toLowerCase().includes("kit découverte") ||
    node.title?.toLowerCase().includes("kit decouverte"));
  const totalPots = items.reduce((s, { node }) => {
    const t = node.title?.toLowerCase() ?? "";
    return t.includes("kit") ? s : s + (node.quantity ?? 0);
  }, 0);
  switch (country) {
    case "FR": return isKitUltime ? 9.29 : isKitDecouverte ? 5.49 : totalPots >= 3 ? 7.59 : 5.49;
    case "BE": return isKitUltime ? 6.60 : 4.60;
    case "IT": return isKitUltime ? 9.50 : 6.60;
    case "DE": return isKitUltime ? 13.80 : 12.50;
    case "CH": return isKitUltime ? 19.39 : 14.99;
    default:   return 0;
  }
}

interface ShopifyStats {
  totalRevenue: number;
  totalShipping: number;
  totalProductCost: number;
  totalPotsVendus: number;
  orderCount: number;
  scopeError: boolean;
}

async function fetchShopifyOrders(admin: AdminClient, shop: string): Promise<ShopifyStats> {
  const zero = { totalRevenue: 0, totalShipping: 0, totalProductCost: 0, totalPotsVendus: 0, orderCount: 0 };
  try {
    const res  = await admin.graphql(ORDERS_QUERY);
    const data = (await res.json()) as {
      data?: { orders?: { edges: { node: OrderNode }[] } };
      errors?: { message?: string }[];
    };

    if (data.errors?.length) {
      console.error(`[Dashboard] GraphQL error (${shop}):`, JSON.stringify(data.errors));
      const isScope = data.errors.some(e =>
        e.message?.toLowerCase().includes("access denied") ||
        e.message?.toLowerCase().includes("read_orders"));
      return { ...zero, scopeError: isScope };
    }

    const orders = data.data?.orders;
    if (!orders) return { ...zero, scopeError: false };

    let totalRevenue = 0, totalShipping = 0, totalProductCost = 0, totalPotsVendus = 0, orderCount = 0;

    for (const { node } of orders.edges) {
      totalRevenue     += parseFloat(node.currentTotalPriceSet?.shopMoney?.amount ?? "0");
      totalShipping    += getShippingCost(node);
      totalProductCost += getProductCost(node);
      for (const { node: item } of node.lineItems?.edges ?? []) {
        const t = (item.title ?? "").toLowerCase();
        const q = item.quantity ?? 1;
        totalPotsVendus += t.includes("kit ultime") ? q * 3 : t.includes("kit découverte") || t.includes("kit decouverte") ? q * 2 : q;
      }
      orderCount++;
    }

    return { totalRevenue, totalShipping, totalProductCost, totalPotsVendus, orderCount, scopeError: false };
  } catch (err) {
    console.error(`[Dashboard] fetchShopifyOrders error (${shop}):`, err);
    return { ...zero, scopeError: false };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [shopify, depenseAgg, creatorAgg, nbContents] = await Promise.all([
    fetchShopifyOrders(admin as AdminClient, session.shop),
    safeAggregate(() => prisma.depense.aggregate({ _sum: { montantTTC: true } }), { _sum: { montantTTC: null } }),
    safeAggregate(() => prisma.creator.aggregate({ _sum: { coutTotalCollab: true }, _count: { _all: true } }),
      { _sum: { coutTotalCollab: null }, _count: { _all: 0 } }),
    safeAggregate(() => prisma.creator.count({ where: { lienVideo: { not: null } } }), 0),
  ]);

  // ── Constantes ───────────────────────────────────────────────────────────────
  const marketingCosts   = 731.59;
  const stockInitialPots = 200;
  const stockTotalCost   = 1830.24;

  // ── P&L ──────────────────────────────────────────────────────────────────────
  const ca                  = shopify.totalRevenue;
  const nbCommandes         = shopify.orderCount;
  const panierMoyen         = nbCommandes > 0 ? ca / nbCommandes : 0;
  const totalCOGS           = shopify.totalProductCost;
  const totalFraisLivraison = shopify.totalShipping;
  const totalDepenses       = depenseAgg._sum.montantTTC ?? 0;
  const totalFraisUgc       = creatorAgg._sum.coutTotalCollab ?? 0;
  const totalDepense        = totalCOGS + totalDepenses + totalFraisLivraison + totalFraisUgc + marketingCosts;
  const resultatNet         = ca - totalDepense;
  const margeNettePct       = ca > 0 ? (resultatNet / ca) * 100 : 0;
  const coutParCommande     = nbCommandes > 0 ? totalDepense / nbCommandes : 0;

  // Seuil de rentabilité (commandes nécessaires pour couvrir les charges fixes)
  const chargesFixees       = marketingCosts + totalDepenses + totalFraisUgc;
  const margeVariableParCmd = nbCommandes > 0 ? (ca - totalCOGS - totalFraisLivraison) / nbCommandes : 0;
  const seuilRentabilite    = margeVariableParCmd > 0 ? Math.ceil(chargesFixees / margeVariableParCmd) : 0;

  // ── Stock ─────────────────────────────────────────────────────────────────────
  const potsVendus          = shopify.totalPotsVendus;
  const potsRestants        = Math.max(0, stockInitialPots - potsVendus);
  const stockConsomme       = totalCOGS;
  const stockRestantValeur  = Math.max(0, stockTotalCost - stockConsomme);
  const stockPctEcoule      = stockInitialPots > 0 ? (potsVendus / stockInitialPots) * 100 : 0;

  return {
    ca, nbCommandes, panierMoyen,
    totalCOGS, totalFraisLivraison, marketingCosts, totalDepenses, totalFraisUgc,
    totalDepense, resultatNet, margeNettePct, coutParCommande, seuilRentabilite,
    stockTotalCost, stockInitialPots, stockConsomme, stockRestantValeur, potsVendus, potsRestants, stockPctEcoule,
    nbCreateurs: creatorAgg._count._all ?? 0,
    nbContents:  nbContents ?? 0,
    scopeError:  shopify.scopeError,
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function eur(n: number) {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function pctStr(value: number, total: number): string | null {
  if (total === 0) return null;
  return ((value / total) * 100).toFixed(1) + " %";
}

// ─── Design tokens ───────────────────────────────────────────────────────────

const T = {
  bg:       "#f8fafc",
  card:     "#ffffff",
  border:   "#e2e8f0",
  text:     "#0f172a",
  muted:    "#64748b",
  dim:      "#94a3b8",
  accent:   "#6366f1",
  green:    "#059669",
  greenBg:  "#f0fdf4",
  greenBdr: "#86efac",
  orange:   "#d97706",
  orangeBg: "#fffbeb",
  orangeBdr:"#fde68a",
  red:      "#dc2626",
  redBg:    "#fef2f2",
  redBdr:   "#fca5a5",
  shadow:   "0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04)",
};

// ─── Responsive CSS ───────────────────────────────────────────────────────────

const RESPONSIVE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  .dash-wrap { padding: 36px 40px 60px; overflow-x: hidden; }
  .dash-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .dash-grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .dash-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .hero-val { font-size: 38px; }
  @media (max-width: 640px) {
    .dash-wrap { padding: 16px 14px 48px; }
    .dash-grid-3,
    .dash-grid-4,
    .dash-grid-2 { grid-template-columns: 1fr; gap: 10px; }
    .hero-val { font-size: 30px; }
  }
  @media (min-width: 641px) and (max-width: 900px) {
    .dash-wrap { padding: 24px 20px 48px; }
    .dash-grid-3,
    .dash-grid-4 { grid-template-columns: repeat(2, 1fr); }
    .hero-val { font-size: 32px; }
  }
`;

// ─── Components ──────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <span style={{ display: "block", width: 3, height: 16, borderRadius: 99, background: T.accent, flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: T.muted }}>
        {children}
      </span>
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  sub?: string | null;
  valueColor?: string;
  accentTop?: boolean;
  bg?: string;
  borderColor?: string;
}

function MetricCard({ label, value, sub, valueColor, accentTop, bg, borderColor }: MetricCardProps) {
  return (
    <div style={{
      background: bg ?? T.card,
      border: `1px solid ${borderColor ?? T.border}`,
      borderTop: accentTop ? `3px solid ${T.accent}` : undefined,
      borderRadius: 14,
      padding: "16px 18px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
      boxShadow: T.shadow,
      minWidth: 0,
    }}>
      <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, color: valueColor ?? T.text, fontVariantNumeric: "tabular-nums", wordBreak: "break-word" }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{sub}</span>}
    </div>
  );
}

interface HeroCardProps {
  label: string;
  value: number;
  forceColor?: "green" | "red";
  alert?: "green" | "orange" | "red";
  sub?: string;
}

function HeroCard({ label, value, forceColor, alert, sub }: HeroCardProps) {
  let color: string, bg: string, bdr: string;
  if (forceColor === "green") { color = T.green; bg = T.greenBg; bdr = T.greenBdr; }
  else if (forceColor === "red") { color = T.red; bg = T.redBg; bdr = T.redBdr; }
  else if (alert === "orange") { color = T.orange; bg = T.orangeBg; bdr = T.orangeBdr; }
  else if (alert === "red" || value < 0) { color = T.red; bg = T.redBg; bdr = T.redBdr; }
  else { color = T.green; bg = T.greenBg; bdr = T.greenBdr; }

  return (
    <div style={{ background: bg, border: `2px solid ${bdr}`, borderRadius: 18, padding: "20px 20px 18px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.08)", minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color, opacity: 0.75 }}>{label}</span>
      <span className="hero-val" style={{ fontWeight: 800, lineHeight: 1.1, color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", wordBreak: "break-word" }}>
        {eur(value)}
      </span>
      {sub && <span style={{ fontSize: 13, color, opacity: 0.75, marginTop: 2 }}>{sub}</span>}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();

  // Alerte résultat net
  const netAlert: "green" | "orange" | "red" =
    d.resultatNet < 0 ? "red" : d.margeNettePct < 10 ? "orange" : "green";

  return (
    <>
      <style>{RESPONSIVE_CSS}</style>
      <div className="dash-wrap" style={{ minHeight: "100vh", background: T.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>

          {/* Alerte scope */}
          {d.scopeError && (
            <div style={{ background: T.orangeBg, border: `1px solid ${T.orange}`, borderRadius: 10, padding: "12px 16px", marginBottom: 24, fontSize: 13, color: "#92400e" }}>
              Scope insuffisant — ajoutez <strong>read_orders</strong> dans les scopes de l'app et réinstallez-la.
            </div>
          )}

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32, flexWrap: "wrap", gap: 8 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text, letterSpacing: "-0.02em" }}>Dashboard Laya</h1>
              <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>Données en temps réel — 50 dernières commandes</p>
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, background: "#eef2ff", padding: "4px 10px", borderRadius: 99, border: "1px solid #c7d2fe", whiteSpace: "nowrap" }}>
              Laya
            </span>
          </div>

          {/* ══ BLOC A — RENTABILITÉ RÉELLE ══════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Rentabilité réelle</SectionLabel>

            {/* Hero : CA / Total dépensé / Résultat net */}
            <div className="dash-grid-3" style={{ marginBottom: 14 }}>
              <HeroCard label="Chiffre d'affaires" value={d.ca} forceColor="green" sub={`${d.nbCommandes} commandes`} />
              <HeroCard label="Total dépensé" value={d.totalDepense} forceColor="red" sub={`Coût par commande : ${eur(d.coutParCommande)}`} />
              <HeroCard label="Résultat net" value={d.resultatNet} alert={netAlert}
                sub={`Marge nette : ${d.margeNettePct.toFixed(1)} %${d.margeNettePct > 0 && d.margeNettePct < 10 ? " ⚠️ < 10 %" : ""}`} />
            </div>

            {/* Métriques commandes */}
            <div className="dash-grid-4" style={{ marginBottom: 14 }}>
              <MetricCard label="Panier moyen" value={eur(d.panierMoyen)} sub="par commande" />
              <MetricCard label="Marge nette" value={d.margeNettePct.toFixed(1) + " %"}
                valueColor={d.margeNettePct < 0 ? T.red : d.margeNettePct < 10 ? T.orange : T.green} />
              <MetricCard label="Coût / commande" value={eur(d.coutParCommande)} valueColor={T.red} />
              <MetricCard label="Seuil rentabilité" value={d.seuilRentabilite > 0 ? `${d.seuilRentabilite} cmd` : "—"}
                sub={d.seuilRentabilite > 0 ? d.nbCommandes >= d.seuilRentabilite ? "✓ Atteint" : `${d.seuilRentabilite - d.nbCommandes} cmd restantes` : undefined}
                valueColor={d.nbCommandes >= d.seuilRentabilite && d.seuilRentabilite > 0 ? T.green : T.orange} />
            </div>

            {/* Détail coûts */}
            <div className="dash-grid-3" style={{ marginBottom: 14 }}>
              <MetricCard label="Coût produits vendus (COGS)" value={eur(d.totalCOGS)}
                sub={pctStr(d.totalCOGS, d.ca) ? pctStr(d.totalCOGS, d.ca) + " du CA" : undefined}
                valueColor={T.red} />
              <MetricCard label="Frais livraison" value={eur(d.totalFraisLivraison)}
                sub={pctStr(d.totalFraisLivraison, d.ca) ? pctStr(d.totalFraisLivraison, d.ca) + " du CA" : undefined}
                valueColor={T.red} />
              <MetricCard label="Marketing Ads" value={eur(d.marketingCosts)}
                sub={pctStr(d.marketingCosts, d.ca) ? pctStr(d.marketingCosts, d.ca) + " du CA" : undefined}
                valueColor={T.red} accentTop />
            </div>
            <div className="dash-grid-2">
              <MetricCard label="Dépenses annexes" value={eur(d.totalDepenses)}
                sub={pctStr(d.totalDepenses, d.ca) ? pctStr(d.totalDepenses, d.ca) + " du CA" : undefined}
                valueColor={T.red} />
              <MetricCard label="Frais UGC" value={eur(d.totalFraisUgc)}
                sub={pctStr(d.totalFraisUgc, d.ca) ? pctStr(d.totalFraisUgc, d.ca) + " du CA" : undefined}
                valueColor={T.red} />
            </div>
          </section>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

          {/* ══ BLOC B — STOCK / INVESTISSEMENT ═════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Stock / Investissement (info — non déduit du résultat)</SectionLabel>
            <div className="dash-grid-4">
              <MetricCard label="Stock total acheté" value={eur(d.stockTotalCost)}
                sub={`${d.stockInitialPots} pots initiaux`} />
              <MetricCard label="Stock consommé" value={eur(d.stockConsomme)}
                sub={`${d.potsVendus} pots vendus`} valueColor={T.orange} />
              <MetricCard label="Stock restant estimé" value={eur(d.stockRestantValeur)}
                sub={`${d.potsRestants} pots restants`} valueColor={T.green} />
              <MetricCard label="Stock écoulé" value={d.stockPctEcoule.toFixed(1) + " %"}
                sub={`${d.potsVendus} / ${d.stockInitialPots} pots`}
                valueColor={d.stockPctEcoule > 80 ? T.red : d.stockPctEcoule > 50 ? T.orange : T.green} />
            </div>
          </section>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

          {/* ══ UGC ══════════════════════════════════════════════════════════ */}
          <section>
            <SectionLabel>UGC</SectionLabel>
            <div className="dash-grid-2">
              <MetricCard label="Créateurs" value={String(d.nbCreateurs)} sub="collabs total" />
              <MetricCard label="Contenus postés" value={String(d.nbContents)} sub="vidéos avec lien" />
            </div>
          </section>

        </div>
      </div>
    </>
  );
}
