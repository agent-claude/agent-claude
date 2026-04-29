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
          name
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
  name?: string;
  currentTotalPriceSet?: { shopMoney?: { amount?: string } };
  shippingAddress?: { countryCode?: string };
  lineItems?: { edges: { node: { title?: string; quantity?: number } }[] };
}

// ── Coûts unitaires réels (facture CMD-001) ───────────────────────────────────
const POT_COST   = 3.77055;
const BOL_COST   = 4.1806;
const FOUET_COST = 4.1806;

// ── Composition produits ──────────────────────────────────────────────────────
type ProductType = "kit_ultime" | "kit_decouverte" | "3_pots" | "2_pots" | "pot" | "inconnu";

interface LineItemBreakdown {
  title: string;
  qty: number;
  type: ProductType;
  composition: string;
  unitCost: number;
  totalCost: number;
}

interface OrderBreakdown {
  name: string;
  revenue: number;
  country: string;
  items: LineItemBreakdown[];
  productCost: number;
  shippingCost: number;
}

function classifyItem(rawTitle: string, qty: number): LineItemBreakdown {
  const t = rawTitle.toLowerCase();
  let type: ProductType, composition: string, unitCost: number;

  if (t.includes("kit ultime")) {
    type = "kit_ultime"; composition = "1 pot + fouet + bol";
    unitCost = POT_COST + FOUET_COST + BOL_COST;
  } else if (t.includes("kit découverte") || t.includes("kit decouverte")) {
    type = "kit_decouverte"; composition = "1 pot + fouet";
    unitCost = POT_COST + FOUET_COST;
  } else if (t.includes("3 pot") || t.includes("3pot") || t.match(/^3\s*x?\s*pot/)) {
    type = "3_pots"; composition = "3 pots";
    unitCost = 3 * POT_COST;
  } else if (t.includes("2 pot") || t.includes("2pot") || t.match(/^2\s*x?\s*pot/)) {
    type = "2_pots"; composition = "2 pots";
    unitCost = 2 * POT_COST;
  } else if (t.includes("pot") || t.includes("matcha")) {
    type = "pot"; composition = "1 pot";
    unitCost = POT_COST;
  } else {
    type = "inconnu"; composition = "?";
    unitCost = 0;
  }

  return { title: rawTitle, qty, type, composition, unitCost, totalCost: qty * unitCost };
}

function potsInItem(item: LineItemBreakdown): number {
  switch (item.type) {
    case "kit_ultime":    return item.qty * 1;
    case "kit_decouverte":return item.qty * 1;
    case "3_pots":        return item.qty * 3;
    case "2_pots":        return item.qty * 2;
    case "pot":           return item.qty * 1;
    default:              return 0;
  }
}

function getShippingCost(classified: LineItemBreakdown[], country: string): number {
  const c           = country.toUpperCase();
  const hasUltime   = classified.some(i => i.type === "kit_ultime");
  const hasDecouverte = classified.some(i => i.type === "kit_decouverte");
  const totalPots   = classified.reduce((s, i) => s + potsInItem(i), 0);
  switch (c) {
    case "FR": return hasUltime ? 9.29 : hasDecouverte ? 5.49 : totalPots >= 3 ? 7.59 : 5.49;
    case "BE": return hasUltime ? 6.60 : 4.60;
    case "IT": return hasUltime ? 9.50 : 6.60;
    case "DE": return hasUltime ? 13.80 : 12.50;
    case "CH": return hasUltime ? 19.39 : 14.99;
    default:   return 0;
  }
}

interface ShopifyStats {
  totalRevenue: number;
  totalShipping: number;
  totalProductCost: number;
  totalPotsVendus: number;
  orderCount: number;
  orderBreakdowns: OrderBreakdown[];
  scopeError: boolean;
}

async function fetchShopifyOrders(admin: AdminClient, shop: string): Promise<ShopifyStats> {
  const zero = { totalRevenue: 0, totalShipping: 0, totalProductCost: 0, totalPotsVendus: 0, orderCount: 0, orderBreakdowns: [] as OrderBreakdown[] };
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
    const orderBreakdowns: OrderBreakdown[] = [];

    for (const { node } of orders.edges) {
      const revenue  = parseFloat(node.currentTotalPriceSet?.shopMoney?.amount ?? "0");
      const country  = (node.shippingAddress?.countryCode ?? "").toUpperCase();
      const items    = (node.lineItems?.edges ?? []).map(({ node: li }) =>
        classifyItem(li.title ?? "", li.quantity ?? 1));
      const productCost  = items.reduce((s, i) => s + i.totalCost, 0);
      const shippingCost = getShippingCost(items, country);

      totalRevenue     += revenue;
      totalShipping    += shippingCost;
      totalProductCost += productCost;
      totalPotsVendus  += items.reduce((s, i) => s + potsInItem(i), 0);
      orderCount++;

      orderBreakdowns.push({
        name: node.name ?? `#${orderCount}`,
        revenue,
        country: country || "?",
        items,
        productCost,
        shippingCost,
      });
    }

    return { totalRevenue, totalShipping, totalProductCost, totalPotsVendus, orderCount, orderBreakdowns, scopeError: false };
  } catch (err) {
    console.error(`[Dashboard] fetchShopifyOrders error (${shop}):`, err);
    return { ...zero, scopeError: false };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [shopify, depenseAgg, creatorAgg, nbContents, offertsAgg] = await Promise.all([
    fetchShopifyOrders(admin as AdminClient, session.shop),
    safeAggregate(() => prisma.depense.aggregate({ _sum: { montantTTC: true } }), { _sum: { montantTTC: null } }),
    safeAggregate(() => prisma.creator.aggregate({ _sum: { coutTotalCollab: true }, _count: { _all: true } }),
      { _sum: { coutTotalCollab: null }, _count: { _all: 0 } }),
    safeAggregate(() => prisma.creator.count({ where: { lienVideo: { not: null } } }), 0),
    safeAggregate(
      () => prisma.produitOffert.aggregate({ _sum: { coutTotal: true, potsEquivalent: true } }),
      { _sum: { coutTotal: null, potsEquivalent: null } },
    ),
  ]);

  // ── Constantes ───────────────────────────────────────────────────────────────
  const marketingCosts   = 731.59;
  const stockInitialPots = 200;
  const stockTotalCost   = 1830.24;

  const totalDepenses       = depenseAgg._sum.montantTTC ?? 0;
  const totalFraisUgc       = creatorAgg._sum.coutTotalCollab ?? 0;

  // ── Produits offerts ─────────────────────────────────────────────────────────
  const coutProduitsOfferts = offertsAgg._sum.coutTotal      ?? 0;
  const potsOfferts         = offertsAgg._sum.potsEquivalent ?? 0;

  // ── Bloc 1 : Résultat business (hors ads) ────────────────────────────────────
  const ca                  = shopify.totalRevenue;
  const nbCommandes         = shopify.orderCount;
  const panierMoyen         = nbCommandes > 0 ? ca / nbCommandes : 0;
  const totalCOGS           = shopify.totalProductCost;
  const totalFraisLivraison = shopify.totalShipping;
  const coutsDirects        = totalCOGS + totalFraisLivraison + coutProduitsOfferts;
  const resultatBusiness    = ca - coutsDirects;
  const margeBusinessPct    = ca > 0 ? (resultatBusiness / ca) * 100 : 0;
  const profitParCommande   = nbCommandes > 0 ? resultatBusiness / nbCommandes : 0;

  // ── Bloc 2 : Marketing Ads ────────────────────────────────────────────────────
  // Aucune commande générée via les ads → ROAS réel = 0
  const perteAds            = -marketingCosts;

  // Seuil : nb commandes nécessaires pour rentabiliser les ads
  const margeParCmd         = nbCommandes > 0 ? resultatBusiness / nbCommandes : 0;
  const seuilMarketing      = margeParCmd > 0 ? Math.ceil(marketingCosts / margeParCmd) : 0;

  // ── Bloc 3 : Résultat global ──────────────────────────────────────────────────
  const autresCharges       = totalDepenses + totalFraisUgc;
  const totalChargesGlobal  = coutsDirects + marketingCosts + autresCharges; // coutsDirects inclut déjà produitsOfferts
  const resultatGlobal      = ca - totalChargesGlobal;
  const margeGlobalePct     = ca > 0 ? (resultatGlobal / ca) * 100 : 0;
  const coutParCommande     = nbCommandes > 0 ? totalChargesGlobal / nbCommandes : 0;

  // ── Stock ─────────────────────────────────────────────────────────────────────
  const potsVendus          = shopify.totalPotsVendus;
  const potsConsommes       = potsVendus + potsOfferts;
  const potsRestants        = Math.max(0, stockInitialPots - potsConsommes);
  const stockConsomme       = totalCOGS + coutProduitsOfferts;
  const stockRestantValeur  = Math.max(0, stockTotalCost - stockConsomme);
  const stockPctEcoule      = stockInitialPots > 0 ? (potsConsommes / stockInitialPots) * 100 : 0;

  return {
    // Commun
    ca, nbCommandes, panierMoyen, totalCOGS, totalFraisLivraison,
    coutProduitsOfferts, potsOfferts,
    // Bloc 1
    coutsDirects, resultatBusiness, margeBusinessPct, profitParCommande,
    // Bloc 2
    marketingCosts, perteAds, seuilMarketing,
    // Bloc 3
    totalDepenses, totalFraisUgc, autresCharges,
    totalChargesGlobal, resultatGlobal, margeGlobalePct, coutParCommande,
    // Stock
    stockTotalCost, stockInitialPots, stockConsomme, stockRestantValeur,
    potsVendus, potsConsommes, potsRestants, stockPctEcoule,
    // Autres
    nbCreateurs: creatorAgg._count._all ?? 0,
    nbContents:  nbContents ?? 0,
    orderBreakdowns: shopify.orderBreakdowns,
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

  const businessAlert: "green" | "orange" | "red" =
    d.resultatBusiness < 0 ? "red" : d.margeBusinessPct < 10 ? "orange" : "green";
  const globalAlert: "green" | "orange" | "red" =
    d.resultatGlobal < 0 ? "red" : d.margeGlobalePct < 10 ? "orange" : "green";

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

          {/* ══ BLOC 1 — RÉSULTAT BUSINESS (HORS ADS) ════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Résultat business — hors ads</SectionLabel>

            <div className="dash-grid-3" style={{ marginBottom: 14 }}>
              <HeroCard label="Chiffre d'affaires" value={d.ca} forceColor="green"
                sub={`${d.nbCommandes} commandes · panier ${eur(d.panierMoyen)}`} />
              <HeroCard label="Coûts directs" value={d.coutsDirects} forceColor="red"
                sub={`COGS ${eur(d.totalCOGS)} + livraison ${eur(d.totalFraisLivraison)}`} />
              <HeroCard label="Résultat business" value={d.resultatBusiness} alert={businessAlert}
                sub={`Marge brute : ${d.margeBusinessPct.toFixed(1)} %`} />
            </div>

            <div className="dash-grid-4">
              <MetricCard label="COGS (coût produits)" value={eur(d.totalCOGS)}
                sub={pctStr(d.totalCOGS, d.ca) + " du CA"} valueColor={T.red} />
              <MetricCard label="Frais livraison" value={eur(d.totalFraisLivraison)}
                sub={pctStr(d.totalFraisLivraison, d.ca) + " du CA"} valueColor={T.red} />
              <MetricCard
                label="Produits offerts"
                value={eur(d.coutProduitsOfferts)}
                sub={d.potsOfferts > 0 ? `${d.potsOfferts} pots — UGC, cafés, collabs` : "Aucun enregistré"}
                valueColor={d.coutProduitsOfferts > 0 ? T.red : T.muted}
              />
              <MetricCard label="Profit / commande" value={eur(d.profitParCommande)}
                sub="résultat business ÷ commandes"
                valueColor={d.profitParCommande < 0 ? T.red : T.green} />
            </div>

            {d.coutProduitsOfferts === 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: T.muted, background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 10, padding: "10px 14px" }}>
                Aucun produit offert enregistré.{" "}
                <a href="/app/produits-offerts" style={{ color: T.accent, fontWeight: 600 }}>Gérer les produits offerts →</a>
              </div>
            )}
          </section>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

          {/* ══ BLOC 2 — MARKETING ADS ═══════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Marketing Ads (Meta)</SectionLabel>

            <div className="dash-grid-3" style={{ marginBottom: 14 }}>
              <HeroCard label="Dépenses ads" value={d.marketingCosts} forceColor="red"
                sub="Budget Meta Ads total" />
              <div style={{ background: T.orangeBg, border: `2px solid ${T.orangeBdr}`, borderRadius: 18, padding: "20px 20px 18px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.08)", minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: T.orange, opacity: 0.75 }}>ROAS réel</span>
                <span className="hero-val" style={{ fontWeight: 800, lineHeight: 1.1, color: T.orange, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>×0.00</span>
                <span style={{ fontSize: 13, color: T.orange, opacity: 0.75, marginTop: 2 }}>0 commande générée via ads</span>
              </div>
              <HeroCard label="Perte ads nette" value={d.perteAds} alert="red"
                sub="Aucun CA attribuable aux ads" />
            </div>

            <div className="dash-grid-2">
              <MetricCard
                label="Seuil rentabilité ads"
                value={d.seuilMarketing > 0 ? `${d.seuilMarketing} cmd` : "—"}
                sub={d.seuilMarketing > 0
                  ? `${d.seuilMarketing - d.nbCommandes} cmd supplémentaires pour rentabiliser les ads`
                  : undefined}
                valueColor={T.orange}
              />
              <MetricCard label="Coût ads / commande actuelle" value={eur(d.marketingCosts / Math.max(d.nbCommandes, 1))}
                sub="si ads attribuées à toutes les commandes" valueColor={T.red} />
            </div>
          </section>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

          {/* ══ BLOC 3 — RÉSULTAT GLOBAL ══════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Résultat global (toutes charges)</SectionLabel>

            <div className="dash-grid-3" style={{ marginBottom: 14 }}>
              <HeroCard label="Chiffre d'affaires" value={d.ca} forceColor="green"
                sub={`${d.nbCommandes} commandes`} />
              <HeroCard label="Total charges" value={d.totalChargesGlobal} forceColor="red"
                sub={`Coût par commande : ${eur(d.coutParCommande)}`} />
              <HeroCard label="Résultat global" value={d.resultatGlobal} alert={globalAlert}
                sub={`Marge nette : ${d.margeGlobalePct.toFixed(1)} %`} />
            </div>

            <div className="dash-grid-4">
              <MetricCard label="COGS" value={eur(d.totalCOGS)}
                sub={pctStr(d.totalCOGS, d.ca) + " du CA"} valueColor={T.red} />
              <MetricCard label="Produits offerts" value={eur(d.coutProduitsOfferts)}
                sub={`${d.potsOfferts} pots offerts`} valueColor={T.red} />
              <MetricCard label="Livraison" value={eur(d.totalFraisLivraison)}
                sub={pctStr(d.totalFraisLivraison, d.ca) + " du CA"} valueColor={T.red} />
              <MetricCard label="Ads Meta" value={eur(d.marketingCosts)}
                sub={pctStr(d.marketingCosts, d.ca) + " du CA"} valueColor={T.red} accentTop />
            </div>
            <div className="dash-grid-2" style={{ marginTop: 10 }}>
              <MetricCard label="Dépenses annexes" value={eur(d.totalDepenses)}
                sub={pctStr(d.totalDepenses, d.ca) + " du CA"} valueColor={T.red} />
              <MetricCard label="Frais UGC (port + collab)" value={eur(d.totalFraisUgc)}
                sub={pctStr(d.totalFraisUgc, d.ca) + " du CA"} valueColor={T.red} />
            </div>
          </section>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

          {/* ══ STOCK ════════════════════════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Stock (info — non déduit du résultat business)</SectionLabel>
            <div className="dash-grid-4" style={{ marginBottom: 10 }}>
              <MetricCard label="Stock initial" value={eur(d.stockTotalCost)}
                sub={`${d.stockInitialPots} pots achetés`} />
              <MetricCard label="Vendus (Shopify)" value={eur(d.totalCOGS)}
                sub={`${d.potsVendus} pots`} valueColor={T.red} />
              <MetricCard label="Offerts (UGC / cafés)" value={eur(d.coutProduitsOfferts)}
                sub={d.potsOfferts > 0 ? `${d.potsOfferts} pots` : "0 pot enregistré"}
                valueColor={d.potsOfferts > 0 ? T.orange : T.muted} />
              <MetricCard label="Stock restant réel" value={eur(d.stockRestantValeur)}
                sub={`${d.potsRestants} pots (${d.potsConsommes} consommés / ${d.stockInitialPots})`}
                valueColor={T.green} />
            </div>
            <MetricCard label="Stock écoulé" value={d.stockPctEcoule.toFixed(1) + " %"}
              sub={`${d.potsVendus} vendus + ${d.potsOfferts} offerts = ${d.potsConsommes} / ${d.stockInitialPots} pots`}
              valueColor={d.stockPctEcoule > 80 ? T.red : d.stockPctEcoule > 50 ? T.orange : T.green} />
          </section>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

          {/* ══ VÉRIFICATION COGS ═══════════════════════════════════════════ */}
          <section style={{ marginBottom: 48 }}>
            <SectionLabel>Vérification COGS — détail par commande</SectionLabel>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["Commande", "Pays", "Produit", "Qté", "Composition", "Coût unit.", "Coût total", "Livraison", "CA"].map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.orderBreakdowns.map((order, oi) =>
                    order.items.map((item, ii) => (
                      <tr key={`${oi}-${ii}`} style={{ background: ii === 0 && oi % 2 === 0 ? "#fff" : ii === 0 && oi % 2 !== 0 ? "#f8fafc" : "transparent", borderTop: ii === 0 ? `1px solid ${T.border}` : undefined }}>
                        {ii === 0 && (
                          <>
                            <td rowSpan={order.items.length} style={{ padding: "8px 10px", fontWeight: 700, color: T.accent, whiteSpace: "nowrap", verticalAlign: "top" }}>{order.name}</td>
                            <td rowSpan={order.items.length} style={{ padding: "8px 10px", color: T.muted, verticalAlign: "top" }}>{order.country}</td>
                          </>
                        )}
                        <td style={{ padding: "6px 10px", color: T.text, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</td>
                        <td style={{ padding: "6px 10px", color: T.muted, textAlign: "center" }}>{item.qty}</td>
                        <td style={{ padding: "6px 10px" }}>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 99,
                            background: item.type === "inconnu" ? T.redBg : item.type.startsWith("kit") ? "#eef2ff" : "#f0fdf4",
                            color: item.type === "inconnu" ? T.red : item.type.startsWith("kit") ? T.accent : T.green,
                          }}>
                            {item.composition}
                          </span>
                        </td>
                        <td style={{ padding: "6px 10px", color: T.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{eur(item.unitCost)}</td>
                        <td style={{ padding: "6px 10px", fontWeight: 600, color: T.red, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{eur(item.totalCost)}</td>
                        {ii === 0 && (
                          <>
                            <td rowSpan={order.items.length} style={{ padding: "8px 10px", color: T.muted, whiteSpace: "nowrap", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{eur(order.shippingCost)}</td>
                            <td rowSpan={order.items.length} style={{ padding: "8px 10px", fontWeight: 600, color: T.green, whiteSpace: "nowrap", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{eur(order.revenue)}</td>
                          </>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                    <td colSpan={6} style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>Total</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: T.red, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{eur(d.totalCOGS)}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: T.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{eur(d.totalFraisLivraison)}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: T.green, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{eur(d.ca)}</td>
                  </tr>
                </tfoot>
              </table>
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
