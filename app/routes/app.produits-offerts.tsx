import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ── Constantes partagées ──────────────────────────────────────────────────────

export const PRODUIT_LABELS: Record<string, string> = {
  pot:           "1 Pot",
  "2_pots":      "2 Pots",
  "3_pots":      "3 Pots",
  kit_decouverte:"Kit Découverte (1 pot + fouet)",
  kit_ultime:    "Kit Ultime (1 pot + fouet + bol)",
};

export const UNIT_COSTS: Record<string, number> = {
  pot:           3.77055,
  "2_pots":      2 * 3.77055,
  "3_pots":      3 * 3.77055,
  kit_decouverte:3.77055 + 4.1806,
  kit_ultime:    3.77055 + 4.1806 + 4.1806,
};

export const POTS_COUNT: Record<string, number> = {
  pot:           1,
  "2_pots":      2,
  "3_pots":      3,
  kit_decouverte:1,
  kit_ultime:    1,
};

const CATEGORIE_LABELS: Record<string, string> = {
  ugc:          "UGC",
  cafe:         "Café / Demo",
  collaboration:"Collaboration",
  autre:        "Autre",
};

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const entries = await prisma.produitOffert.findMany({ orderBy: { date: "desc" } });
  const totaux  = entries.reduce(
    (acc: { cout: number; pots: number }, e) => ({ cout: acc.cout + e.coutTotal, pots: acc.pots + e.potsEquivalent }),
    { cout: 0, pots: 0 },
  );
  return { entries, totaux };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "delete") {
    const id = form.get("id") as string;
    await prisma.produitOffert.delete({ where: { id } });
    return null;
  }

  // create
  const produit  = form.get("produit") as string;
  const quantite = parseInt(form.get("quantite") as string, 10);
  if (!produit || !UNIT_COSTS[produit] || isNaN(quantite) || quantite <= 0) return null;

  const coutUnitaire   = UNIT_COSTS[produit];
  const coutTotal      = coutUnitaire * quantite;
  const potsEquivalent = POTS_COUNT[produit] * quantite;

  await prisma.produitOffert.create({
    data: {
      date:         form.get("date") as string,
      categorie:    form.get("categorie") as string,
      beneficiaire: (form.get("beneficiaire") as string) || null,
      produit,
      quantite,
      coutUnitaire,
      coutTotal,
      potsEquivalent,
      notes:        (form.get("notes") as string) || null,
    },
  });
  return null;
};

// ── Design tokens ─────────────────────────────────────────────────────────────

const T = {
  bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", dim: "#94a3b8",
  accent: "#6366f1", red: "#dc2626", redBg: "#fef2f2",
  green: "#059669", greenBg: "#f0fdf4",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
};

function eur(n: number) {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProduitsOfferts() {
  const { entries, totaux } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const submitting = nav.state === "submitting";

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "32px 24px 60px", fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', boxSizing: "border-box" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 8 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: T.text }}>Produits offerts</h1>
            <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>UGC · Cafés · Collaborations · Offerts sans CA</p>
          </div>
          <a href="/app" style={{ fontSize: 12, color: T.accent, textDecoration: "none", border: `1px solid #c7d2fe`, padding: "4px 12px", borderRadius: 8 }}>
            ← Dashboard
          </a>
        </div>

        {/* Totaux */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
          <div style={{ background: T.redBg, border: "1px solid #fca5a5", borderRadius: 14, padding: "16px 20px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4 }}>Coût total offerts</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.cout)}</div>
          </div>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 20px", boxShadow: T.shadow }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4 }}>Pots équivalents</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: T.text }}>{totaux.pots} pots</div>
          </div>
        </div>

        {/* Formulaire */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: "24px", marginBottom: 28, boxShadow: T.shadow }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.muted, marginBottom: 16 }}>
            Ajouter un produit offert
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <label style={labelStyle}>
                <span style={labelText}>Date</span>
                <input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Catégorie</span>
                <select name="categorie" required style={inputStyle}>
                  {Object.entries(CATEGORIE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Produit</span>
                <select name="produit" required style={inputStyle}>
                  {Object.entries(PRODUIT_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Quantité</span>
                <input name="quantite" type="number" min="1" required defaultValue="1" style={inputStyle} />
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Bénéficiaire (facultatif)</span>
                <input name="beneficiaire" type="text" placeholder="ex: @creator_name, Café Merci..." style={inputStyle} />
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Notes (facultatif)</span>
                <input name="notes" type="text" placeholder="ex: contenu publié, démo en magasin..." style={inputStyle} />
              </label>
            </div>
            <button type="submit" disabled={submitting} style={{
              background: T.accent, color: "#fff", border: "none", borderRadius: 10,
              padding: "10px 20px", fontWeight: 600, fontSize: 13, cursor: "pointer",
              opacity: submitting ? 0.6 : 1,
            }}>
              {submitting ? "Enregistrement..." : "Ajouter"}
            </button>
          </Form>
        </div>

        {/* Table */}
        {entries.length === 0 ? (
          <div style={{ textAlign: "center", color: T.muted, padding: "40px 0", fontSize: 13 }}>
            Aucun produit offert enregistré.
          </div>
        ) : (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f1f5f9" }}>
                  {["Date", "Catégorie", "Bénéficiaire", "Produit", "Qté", "Pots", "Coût", ""].map(h => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e: Awaited<ReturnType<typeof loader>>["entries"][number], i: number) => (
                  <tr key={e.id} style={{ background: i % 2 === 0 ? "#fff" : "#f8fafc", borderTop: `1px solid ${T.border}` }}>
                    <td style={cell}>{e.date}</td>
                    <td style={cell}>
                      <span style={{ background: "#eef2ff", color: T.accent, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99 }}>
                        {CATEGORIE_LABELS[e.categorie] ?? e.categorie}
                      </span>
                    </td>
                    <td style={{ ...cell, color: T.muted }}>{e.beneficiaire ?? "—"}</td>
                    <td style={cell}>{PRODUIT_LABELS[e.produit] ?? e.produit}</td>
                    <td style={{ ...cell, textAlign: "center" }}>{e.quantite}</td>
                    <td style={{ ...cell, textAlign: "center", color: T.muted }}>{e.potsEquivalent}</td>
                    <td style={{ ...cell, fontWeight: 600, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(e.coutTotal)}</td>
                    <td style={cell}>
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={e.id} />
                        <button type="submit" style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 12, padding: "2px 6px" }}>
                          ✕
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                  <td colSpan={5} style={{ padding: "10px 12px", fontWeight: 700, fontSize: 12, color: T.text }}>Total</td>
                  <td style={{ padding: "10px 12px", fontWeight: 700, fontSize: 12 }}>{totaux.pots}</td>
                  <td style={{ padding: "10px 12px", fontWeight: 700, fontSize: 12, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.cout)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const labelText: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em" };
const inputStyle: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", background: "#fff" };
const cell: React.CSSProperties = { padding: "8px 12px", color: "#0f172a" };
