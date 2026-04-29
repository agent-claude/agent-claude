import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

async function safeAggregate<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// Minimal type for admin.graphql — avoids importing internal Shopify types
type AdminClient = {
  graphql: (
    query: string,
    opts?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
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
            edges {
              node {
                title
                quantity
              }
            }
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
  lineItems?: {
    edges: { node: { title?: string; quantity?: number } }[];
  };
}

// Tarifs livraison par pays et type de commande
function getShippingCost(order: OrderNode): number {
  const country = (order.shippingAddress?.countryCode ?? "").toUpperCase();
  const items = order.lineItems?.edges ?? [];

  const isKitUltime = items.some(({ node }) =>
    node.title?.toLowerCase().includes("kit ultime"),
  );
  const isKitDecouverte = items.some(({ node }) =>
    node.title?.toLowerCase().includes("kit découverte") ||
    node.title?.toLowerCase().includes("kit decouverte"),
  );
  const totalPots = items.reduce((sum, { node }) => {
    const title = node.title?.toLowerCase() ?? "";
    if (!title.includes("kit")) return sum + (node.quantity ?? 0);
    return sum;
  }, 0);

  switch (country) {
    case "FR":
      if (isKitUltime) return 9.29;
      if (isKitDecouverte) return 5.49;
      return totalPots >= 3 ? 7.59 : 5.49;

    case "BE":
      return isKitUltime ? 6.60 : 4.60;

    case "IT":
      return isKitUltime ? 9.50 : 6.60;

    case "DE":
      return isKitUltime ? 13.80 : 12.50;

    case "CH":
      return isKitUltime ? 19.39 : 14.99;

    default:
      return 0;
  }
}

// Coûts unitaires réels (source : facture fournisseur CMD-001)
const POT_COST      = 3.77055;
const BOL_COST      = 4.1806;
const FOUET_COST    = 4.1806;
const CUILLERE_COST = 2.40;

function getProductCost(order: OrderNode): number {
  const items = order.lineItems?.edges ?? [];
  let cost = 0;

  for (const { node } of items) {
    const title = (node.title ?? "").toLowerCase();
    const qty   = node.quantity ?? 1;

    if (title.includes("kit ultime")) {
      // 3 pots + bol + fouet + cuillère
      cost += qty * (3 * POT_COST + BOL_COST + FOUET_COST + CUILLERE_COST);
    } else if (title.includes("kit découverte") || title.includes("kit decouverte")) {
      // 2 pots + fouet
      cost += qty * (2 * POT_COST + FOUET_COST);
    } else {
      // Pot seul (1, 2 ou 3 pots selon quantité)
      cost += qty * POT_COST;
    }
  }

  return cost;
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
  try {
    const res = await admin.graphql(ORDERS_QUERY);
    const data = (await res.json()) as {
      data?: { orders?: { edges: { node: OrderNode }[] } };
      errors?: { message?: string }[];
    };

    if (data.errors?.length) {
      console.error(`[Dashboard] GraphQL error (${shop}):`, JSON.stringify(data.errors));
      const isScope = data.errors.some(
        (e) =>
          e.message?.toLowerCase().includes("access denied") ||
          e.message?.toLowerCase().includes("read_orders"),
      );
      if (isScope) return { totalRevenue: 0, totalShipping: 0, totalProductCost: 0, totalPotsVendus: 0, orderCount: 0, scopeError: true };
      return { totalRevenue: 0, totalShipping: 0, totalProductCost: 0, totalPotsVendus: 0, orderCount: 0, scopeError: false };
    }

    const orders = data.data?.orders;
    if (!orders) return { totalRevenue: 0, totalShipping: 0, totalProductCost: 0, totalPotsVendus: 0, orderCount: 0, scopeError: false };

    let totalRevenue = 0;
    let totalShipping = 0;
    let totalProductCost = 0;
    let totalPotsVendus = 0;
    let orderCount = 0;

    for (const { node } of orders.edges) {
      totalRevenue     += parseFloat(node.currentTotalPriceSet?.shopMoney?.amount ?? "0");
      totalShipping    += getShippingCost(node);
      totalProductCost += getProductCost(node);
      // Compter les pots vendus pour le suivi stock
      for (const { node: item } of node.lineItems?.edges ?? []) {
        const title = (item.title ?? "").toLowerCase();
        const qty   = item.quantity ?? 1;
        if (title.includes("kit ultime"))          totalPotsVendus += qty * 3;
        else if (title.includes("kit découverte") || title.includes("kit decouverte")) totalPotsVendus += qty * 2;
        else                                       totalPotsVendus += qty;
      }
      orderCount++;
    }

    console.log(`[Dashboard] ${shop} — ${orderCount} commandes | CA ${totalRevenue.toFixed(2)} € | COGS ${totalProductCost.toFixed(2)} € | ${totalPotsVendus} pots vendus`);

    return { totalRevenue, totalShipping, totalProductCost, totalPotsVendus, orderCount, scopeError: false };
  } catch (err) {
    console.error(`[Dashboard] fetchShopifyOrders error (${shop}):`, err);
    return { totalRevenue: 0, totalShipping: 0, totalProductCost: 0, totalPotsVendus: 0, orderCount: 0, scopeError: false };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [shopify, depenseAgg, creatorAgg, nbContents] = await Promise.all([
    fetchShopifyOrders(admin as AdminClient, session.shop),
    safeAggregate(
      () => prisma.depense.aggregate({ _sum: { montantTTC: true } }),
      { _sum: { montantTTC: null } },
    ),
    safeAggregate(
      () =>
        prisma.creator.aggregate({
          _sum: { coutTotalCollab: true },
          _count: { _all: true },
        }),
      { _sum: { coutTotalCollab: null }, _count: { _all: 0 } },
    ),
    safeAggregate(
      () => prisma.creator.count({ where: { lienVideo: { not: null } } }),
      0,
    ),
  ]);

  const marketingCosts     = 731.59;
  const stockInitialPots   = 200;
  const stockTotalCost     = 1830.24;

  const ca                  = shopify.totalRevenue;
  const nbCommandes         = shopify.orderCount;
  const totalFraisLivraison = shopify.totalShipping;
  const totalAchats         = shopify.totalProductCost;
  const totalDepenses       = depenseAgg._sum.montantTTC ?? 0;
  const totalFraisUgc       = creatorAgg._sum.coutTotalCollab ?? 0;
  const totalDepense        = totalAchats + totalDepenses + totalFraisLivraison + totalFraisUgc + marketingCosts;
  const margeBrute          = ca - totalAchats - totalFraisLivraison;
  const margeNette          = ca - totalDepense;
  const potsVendus          = shopify.totalPotsVendus;
  const potsRestants        = Math.max(0, stockInitialPots - potsVendus);

  return {
    ca,
    nbCommandes,
    panierMoyen: nbCommandes > 0 ? ca / nbCommandes : 0,
    marketingCosts,
    totalAchats,
    totalDepenses,
    totalFraisUgc,
    totalFraisLivraison,
    totalDepense,
    resultatNet: margeNette,
    margeBrute,
    margeNette,
    stockTotalCost,
    stockInitialPots,
    potsVendus,
    potsRestants,
    nbCreateurs: creatorAgg._count._all ?? 0,
    nbContents: nbContents ?? 0,
    scopeError: shopify.scopeError,
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function eur(n: number) {
  return n.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " €";
}

function pct(value: number, total: number) {
  if (total === 0) return null;
  return ((value / total) * 100).toFixed(1) + " %";
}

// ─── Design tokens ───────────────────────────────────────────────────────────

const T = {
  bg: "#f8fafc",
  card: "#ffffff",
  border: "#e2e8f0",
  text: "#0f172a",
  muted: "#64748b",
  dim: "#94a3b8",
  accent: "#6366f1",
  green: "#059669",
  greenBg: "#f0fdf4",
  red: "#dc2626",
  redBg: "#fef2f2",
  shadow: "0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04)",
};

// ─── Components ──────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 14,
      }}
    >
      <span
        style={{
          display: "block",
          width: 3,
          height: 16,
          borderRadius: 99,
          background: T.accent,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: T.muted,
        }}
      >
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
  accent?: boolean;
  large?: boolean;
}

function MetricCard({ label, value, sub, valueColor, accent, large }: MetricCardProps) {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderTop: accent ? `3px solid ${T.accent}` : `1px solid ${T.border}`,
        borderRadius: 14,
        padding: "22px 24px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        boxShadow: T.shadow,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: T.dim,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: large ? 36 : 28,
          fontWeight: 700,
          lineHeight: 1.15,
          color: valueColor ?? T.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
      {sub && (
        <span style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{sub}</span>
      )}
    </div>
  );
}

interface GlobalCardProps {
  label: string;
  value: number;
  forceColor?: "green" | "red" | "neutral";
}

function GlobalCard({ label, value, forceColor }: GlobalCardProps) {
  const positive = value > 0;
  const zero = value === 0;
  const color =
    forceColor === "green"
      ? T.green
      : forceColor === "red"
        ? T.red
        : zero
          ? T.muted
          : positive
            ? T.green
            : T.red;
  const bg =
    forceColor === "green"
      ? T.greenBg
      : forceColor === "red"
        ? T.redBg
        : zero
          ? T.card
          : positive
            ? T.greenBg
            : T.redBg;
  const borderColor =
    forceColor === "green"
      ? "#86efac"
      : forceColor === "red"
        ? "#fca5a5"
        : zero
          ? T.border
          : positive
            ? "#86efac"
            : "#fca5a5";

  return (
    <div
      style={{
        background: bg,
        border: `2px solid ${borderColor}`,
        borderRadius: 18,
        padding: "28px 30px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color,
          opacity: 0.75,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 44,
          fontWeight: 800,
          lineHeight: 1.1,
          color,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.02em",
        }}
      >
        {eur(value)}
      </span>
    </div>
  );
}

interface MarginCardProps {
  label: string;
  value: number;
  ca: number;
}

function MarginCard({ label, value, ca }: MarginCardProps) {
  const positive = value > 0;
  const zero = value === 0;
  const color = zero ? T.muted : positive ? T.green : T.red;
  const bg = zero ? T.card : positive ? T.greenBg : T.redBg;

  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${zero ? T.border : positive ? "#bbf7d0" : "#fecaca"}`,
        borderRadius: 14,
        padding: "22px 24px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        boxShadow: T.shadow,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: zero ? T.dim : positive ? "#16a34a" : "#b91c1c",
          opacity: 0.8,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 30,
          fontWeight: 700,
          lineHeight: 1.15,
          color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {eur(value)}
      </span>
      <span style={{ fontSize: 12, color, opacity: 0.7, marginTop: 2 }}>
        {pct(value, ca) ?? "—"} du CA
      </span>
    </div>
  );
}

interface CountCardProps {
  label: string;
  value: number;
  icon: string;
}

function CountCard({ label, value, icon }: CountCardProps) {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: "22px 24px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        boxShadow: T.shadow,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: T.dim,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
      </div>
      <span
        style={{
          fontSize: 34,
          fontWeight: 700,
          color: T.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();

  const g3: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 14,
  };
  const g4: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 14,
  };
  const g2: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: 14,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        padding: "36px 40px 60px",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>

        {d.scopeError && (
          <div
            style={{
              background: "#fffbeb",
              border: "1px solid #f59e0b",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 24,
              fontSize: 13,
              color: "#92400e",
            }}
          >
            Scope insuffisant — ajoutez <strong>read_orders</strong> dans les scopes de l'app et réinstallez-la. Les données CA affichées sont à 0.
          </div>
        )}

        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 36,
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 700,
                color: T.text,
                letterSpacing: "-0.02em",
              }}
            >
              Dashboard
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: T.muted }}>
              Vue d'ensemble — données en temps réel
            </p>
          </div>
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: T.accent,
              background: "#eef2ff",
              padding: "4px 10px",
              borderRadius: 99,
              border: "1px solid #c7d2fe",
            }}
          >
            Laya
          </span>
        </div>

        {/* ── Bloc 1 : RENTABILITÉ ── */}
        <section style={{ marginBottom: 44 }}>
          <SectionLabel>Rentabilité</SectionLabel>

          {/* Résumé global */}
          <div style={g3}>
            <GlobalCard label="Chiffre d'affaires" value={d.ca} forceColor="green" />
            <GlobalCard label="Total dépensé" value={d.totalDepense} forceColor="red" />
            <GlobalCard label="Résultat net" value={d.resultatNet} />
          </div>

          {/* Détail commandes */}
          <div style={{ ...g3, marginTop: 14 }}>
            <MetricCard label="Commandes" value={String(d.nbCommandes)} sub="50 dernières" />
            <MetricCard label="Panier moyen" value={eur(d.panierMoyen)} sub="par commande" />
            <MetricCard label="Marge nette" value={eur(d.margeNette)}
              sub={pct(d.margeNette, d.ca) ? pct(d.margeNette, d.ca) + " du CA" : "—"}
              valueColor={d.margeNette >= 0 ? T.green : T.red}
            />
          </div>

          {/* Détail coûts */}
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={g3}>
              <MetricCard
                label="Coût produits vendus"
                value={eur(d.totalAchats)}
                sub={pct(d.totalAchats, d.ca) ? pct(d.totalAchats, d.ca) + " du CA" : undefined}
                valueColor={T.red}
              />
              <MetricCard
                label="Frais livraison"
                value={eur(d.totalFraisLivraison)}
                sub={pct(d.totalFraisLivraison, d.ca) ? pct(d.totalFraisLivraison, d.ca) + " du CA" : undefined}
                valueColor={T.red}
              />
              <MetricCard
                label="Marketing"
                value={eur(d.marketingCosts)}
                sub={pct(d.marketingCosts, d.ca) ? pct(d.marketingCosts, d.ca) + " du CA" : undefined}
                valueColor={T.red}
                accent
              />
            </div>
            <div style={g2}>
              <MetricCard
                label="Frais UGC"
                value={eur(d.totalFraisUgc)}
                sub={pct(d.totalFraisUgc, d.ca) ? pct(d.totalFraisUgc, d.ca) + " du CA" : undefined}
                valueColor={T.red}
              />
              <MetricCard
                label="Dépenses annexes"
                value={eur(d.totalDepenses)}
                sub={pct(d.totalDepenses, d.ca) ? pct(d.totalDepenses, d.ca) + " du CA" : undefined}
                valueColor={T.red}
              />
            </div>
          </div>
        </section>

        {/* Divider */}
        <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

        {/* ── Bloc 2 : STOCK (info uniquement) ── */}
        <section style={{ marginBottom: 36 }}>
          <SectionLabel>Stock (informatif)</SectionLabel>
          <div style={g3}>
            <MetricCard
              label="Stock total acheté"
              value={eur(d.stockTotalCost)}
              sub={`${d.stockInitialPots} pots — non déduit du résultat`}
            />
            <MetricCard
              label="Stock utilisé"
              value={`${d.potsVendus} pots`}
              sub={eur(d.potsVendus * 3.77055) + " de matière"}
            />
            <MetricCard
              label="Stock restant estimé"
              value={`${d.potsRestants} pots`}
              sub={eur(d.potsRestants * 3.77055) + " de valeur"}
            />
          </div>
        </section>

        {/* Divider */}
        <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: "0 0 36px" }} />

        {/* ── UGC ── */}
        <section>
          <SectionLabel>UGC</SectionLabel>
          <div style={g2}>
            <CountCard label="Créateurs" value={d.nbCreateurs} icon="👤" />
            <CountCard label="Contenus postés" value={d.nbContents} icon="🎬" />
          </div>
        </section>

      </div>
    </div>
  );
}
