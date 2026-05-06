import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Constante PDF ────────────────────────────────────────────────────────────

const PDF_LINK = "https://cdn.shopify.com/s/files/1/0963/8576/1664/files/Ebook_-_Recettes_Ube_Laya_compressed.pdf?v=1778053423";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const CUSTOMERS_QUERY = `
  query GetCustomers($cursor: String) {
    customers(first: 100, query: "orders_count:>0", after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          displayName
          email
          numberOfOrders
          amountSpent {
            amount
            currencyCode
          }
          createdAt
          updatedAt
          lastOrder {
            id
            name
            createdAt
          }
        }
      }
    }
  }
`;

type ShopifyCustomer = {
  id: string;
  displayName: string;
  email: string | null;
  numberOfOrders: number;
  amountSpent: { amount: string; currencyCode: string };
  createdAt: string;
  updatedAt: string;
  lastOrder: { id: string; name: string; createdAt: string } | null;
};

async function fetchAllCustomers(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> }
): Promise<ShopifyCustomer[]> {
  const all: ShopifyCustomer[] = [];
  let cursor: string | null = null;

  do {
    const res = await admin.graphql(CUSTOMERS_QUERY, {
      variables: cursor ? { cursor } : {},
    });
    const json = await res.json() as {
      data: {
        customers: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: ShopifyCustomer }[];
        };
      };
    };

    const page = json.data?.customers;
    if (!page) break;

    all.push(...page.edges.map((e) => e.node));

    if (page.pageInfo.hasNextPage) {
      cursor = page.pageInfo.endCursor;
    } else {
      cursor = null;
    }
  } while (cursor);

  return all;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const [customers, livrets] = await Promise.all([
    fetchAllCustomers(admin),
    prisma.recetteLivret.findMany(),
  ]);

  const livretMap = new Map(livrets.map((l) => [l.customerId, l]));

  return { customers, livretMap: Object.fromEntries(livretMap), pdfLink: PDF_LINK };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const customerId = String(form.get("customerId") ?? "");
  const email = String(form.get("email") ?? "") || null;
  const name = String(form.get("name") ?? "") || null;

  if (!customerId) return { ok: false };

  if (intent === "marquer_envoye") {
    await prisma.recetteLivret.upsert({
      where: { customerId },
      create: { customerId, email, name, status: "envoye", sentAt: new Date() },
      update: { status: "envoye", sentAt: new Date(), email, name },
    });
  }

  if (intent === "remettre_a_envoyer") {
    await prisma.recetteLivret.upsert({
      where: { customerId },
      create: { customerId, email, name, status: "a_envoyer", sentAt: null },
      update: { status: "a_envoyer", sentAt: null, email, name },
    });
  }

  return { ok: true };
};

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg: "#f8fafc",
  card: "#ffffff",
  border: "#e2e8f0",
  text: "#0f172a",
  muted: "#64748b",
  dim: "#94a3b8",
  accent: "#7c3aed",
  purple: "#7c3aed",
  purpleBg: "#f5f3ff",
  purpleBdr: "#ddd6fe",
  green: "#059669",
  greenBg: "#f0fdf4",
  greenBdr: "#86efac",
  orange: "#d97706",
  orangeBg: "#fffbeb",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
};

const inp: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
  background: "#fff",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtAmount(amount: string, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(Number(amount));
}

// ─── Row client ───────────────────────────────────────────────────────────────

type LivertEntry = { status: string; sentAt: string | null } | undefined;

function ClientRow({
  c,
  livret,
  i,
}: {
  c: ShopifyCustomer;
  livret: LivertEntry;
  i: number;
}) {
  const fetcher = useFetcher();

  const optimisticStatus =
    fetcher.formData?.get("intent") === "marquer_envoye"
      ? "envoye"
      : fetcher.formData?.get("intent") === "remettre_a_envoyer"
      ? "a_envoyer"
      : livret?.status ?? "a_envoyer";

  const isEnvoye = optimisticStatus === "envoye";
  const rowBg = i % 2 === 0 ? "#fff" : "#f8fafc";

  const cell: React.CSSProperties = { padding: "10px 12px", color: T.text, fontSize: 13 };

  return (
    <tr style={{ borderTop: `1px solid ${T.border}`, background: rowBg }}>
      <td style={{ ...cell, fontWeight: 600, minWidth: 160 }}>
        <div>{c.displayName || "—"}</div>
      </td>

      <td style={{ ...cell, color: T.muted, minWidth: 200 }}>
        {c.email || "—"}
      </td>

      <td style={{ ...cell, textAlign: "center" }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: "2px 10px",
            borderRadius: 99,
            background: "#eef2ff",
            color: "#4338ca",
          }}
        >
          {c.numberOfOrders}
        </span>
      </td>

      <td style={{ ...cell, fontVariantNumeric: "tabular-nums", color: T.muted }}>
        {fmtAmount(c.amountSpent.amount, c.amountSpent.currencyCode)}
      </td>

      <td style={{ ...cell }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 10px",
            borderRadius: 99,
            background: isEnvoye ? T.greenBg : T.orangeBg,
            color: isEnvoye ? T.green : T.orange,
            border: `1px solid ${isEnvoye ? T.greenBdr : "#fde68a"}`,
          }}
        >
          {isEnvoye ? "✓ Envoyé" : "À envoyer"}
        </span>
        {isEnvoye && livret?.sentAt && (
          <div style={{ fontSize: 11, color: T.dim, marginTop: 3 }}>
            {fmtDate(livret.sentAt)}
          </div>
        )}
      </td>

      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        <fetcher.Form method="post">
          <input type="hidden" name="customerId" value={c.id} />
          <input type="hidden" name="email" value={c.email ?? ""} />
          <input type="hidden" name="name" value={c.displayName ?? ""} />
          {!isEnvoye ? (
            <button
              name="intent"
              value="marquer_envoye"
              type="submit"
              style={{
                background: T.purple,
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Marquer envoyé
            </button>
          ) : (
            <button
              name="intent"
              value="remettre_a_envoyer"
              type="submit"
              style={{
                background: "none",
                color: T.muted,
                border: `1px solid ${T.border}`,
                borderRadius: 8,
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Remettre à envoyer
            </button>
          )}
        </fetcher.Form>
      </td>
    </tr>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecettesPage() {
  const { customers, livretMap, pdfLink } = useLoaderData<typeof loader>();
  const [pdfLinkInput, setPdfLinkInput] = useState(
    pdfLink === "COLLER_ICI_LE_LIEN_DU_PDF" ? "" : pdfLink
  );
  const [showEmail, setShowEmail] = useState(false);

  const totalEligibles = customers.length;
  const envoyes = customers.filter((c) => livretMap[c.id]?.status === "envoye").length;
  const aEnvoyer = totalEligibles - envoyes;
  const tauxEnvoi = totalEligibles > 0 ? Math.round((envoyes / totalEligibles) * 100) : 0;

  const lienPdf = pdfLinkInput.trim() || "[LIEN_DU_PDF]";

  const emailObjet = "Ton livret recettes Ube Laya est prêt 💜";
  const emailCorps = `Hello 💜

Merci encore pour ta commande Ube Laya.

Pour t'aider à profiter au maximum de ta poudre d'ube, on t'offre notre livret recettes : 25 idées simples, gourmandes et réconfortantes à préparer à la maison.

Tu y trouveras des recettes comme :
– Ube Latte
– Pancakes Ube
– Cookies moelleux
– Tiramisu Ube
– Smoothie violet
– Banana Bread
– et plein d'autres idées violettes ✨

Télécharge ton livret ici :
${lienPdf}

À très vite,
Ube Laya`;

  const kpiStyle = (accent: string, accentBg: string, accentBdr: string): React.CSSProperties => ({
    background: accentBg,
    border: `1px solid ${accentBdr}`,
    borderRadius: 14,
    padding: "16px 20px",
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        padding: "32px 24px 60px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Livret Recettes</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: T.muted }}>
              Clients ayant commandé · Livret PDF "25 recettes à base d'ube"
            </p>
          </div>
          <a
            href="/app"
            style={{ fontSize: 12, color: T.accent, textDecoration: "none", border: `1px solid ${T.purpleBdr}`, padding: "5px 14px", borderRadius: 8, background: T.purpleBg }}
          >
            ← Dashboard
          </a>
        </div>

        {/* Lien PDF */}
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            padding: "16px 20px",
            marginBottom: 20,
            boxShadow: T.shadow,
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
            Lien du PDF
          </div>
          <input
            type="url"
            value={pdfLinkInput}
            onChange={(e) => setPdfLinkInput(e.target.value)}
            placeholder="https://… (coller le lien du livret PDF ici)"
            style={{ ...inp, flex: 1, minWidth: 260 }}
          />
          {pdfLinkInput && (
            <a
              href={pdfLinkInput}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: T.accent, textDecoration: "none", whiteSpace: "nowrap" }}
            >
              Tester le lien ↗
            </a>
          )}
        </div>

        {/* KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
          <div style={kpiStyle(T.accent, T.purpleBg, T.purpleBdr)}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>
              Clients éligibles
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: T.purple }}>{totalEligibles}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>avec au moins 1 commande</div>
          </div>

          <div style={kpiStyle(T.green, T.greenBg, T.greenBdr)}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>
              Livrets envoyés
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: T.green }}>{envoyes}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>marqués comme envoyés</div>
          </div>

          <div style={kpiStyle(T.orange, T.orangeBg, "#fde68a")}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>
              À envoyer
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: T.orange }}>{aEnvoyer}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>livrets en attente</div>
          </div>

          <div style={kpiStyle("#0284c7", "#f0f9ff", "#bae6fd")}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>
              Taux d'envoi
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0284c7" }}>{tauxEnvoi}%</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{envoyes} / {totalEligibles}</div>
          </div>
        </div>

        {/* Email prêt à copier */}
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.purpleBdr}`,
            borderRadius: 14,
            padding: "16px 20px",
            marginBottom: 24,
            boxShadow: T.shadow,
          }}
        >
          <button
            type="button"
            onClick={() => setShowEmail((v) => !v)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.purple }}>
              Email prêt à copier
            </span>
            <span style={{ fontSize: 11, color: T.dim, fontWeight: 400 }}>
              {showEmail ? "▲ Masquer" : "▼ Afficher"}
            </span>
          </button>

          {showEmail && (
            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  Objet
                </div>
                <div
                  style={{
                    background: T.purpleBg,
                    border: `1px solid ${T.purpleBdr}`,
                    borderRadius: 8,
                    padding: "10px 14px",
                    fontSize: 13,
                    color: T.text,
                    userSelect: "all",
                    fontWeight: 500,
                  }}
                >
                  {emailObjet}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  Message
                </div>
                <pre
                  style={{
                    background: "#f8fafc",
                    border: `1px solid ${T.border}`,
                    borderRadius: 8,
                    padding: "14px 16px",
                    fontSize: 13,
                    color: T.text,
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                    margin: 0,
                    userSelect: "all",
                    lineHeight: 1.7,
                  }}
                >
                  {emailCorps}
                </pre>
              </div>

              <div style={{ marginTop: 10, fontSize: 11, color: T.dim }}>
                Cliquer sur le texte pour le sélectionner, puis Copier.
                {!pdfLinkInput && (
                  <span style={{ color: T.orange, fontWeight: 600, marginLeft: 6 }}>
                    ⚠ Renseigne le lien du PDF ci-dessus pour remplacer [LIEN_DU_PDF].
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Tableau clients */}
        {customers.length === 0 ? (
          <div
            style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              padding: "32px 24px",
              textAlign: "center",
              color: T.muted,
              fontSize: 14,
              boxShadow: T.shadow,
            }}
          >
            Aucun client avec commande trouvé dans la boutique.
          </div>
        ) : (
          <div
            style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 16,
              overflow: "hidden",
              boxShadow: T.shadow,
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["Client", "Email", "Commandes", "Total dépensé", "Statut livret", "Action"].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "11px 12px",
                          textAlign: "left",
                          fontWeight: 600,
                          color: T.muted,
                          whiteSpace: "nowrap",
                          borderBottom: `1px solid ${T.border}`,
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c, i) => (
                    <ClientRow
                      key={c.id}
                      c={c}
                      livret={livretMap[c.id] as LivertEntry}
                      i={i}
                    />
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
