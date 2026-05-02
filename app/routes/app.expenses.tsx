import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const CATEGORIES = [
  "Publicité Meta",
  "Shopify",
  "Packaging",
  "Graphiste",
  "Événements",
  "UGC / influence",
  "Transport",
  "Autre",
] as const;

const T = {
  bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", dim: "#94a3b8", accent: "#6366f1",
  green: "#059669", greenBg: "#f0fdf4",
  orange: "#d97706", orangeBg: "#fffbeb", orangeBdr: "#fde68a",
  red: "#dc2626", redBg: "#fef2f2", redBdr: "#fca5a5",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const expenses = await prisma.expense.findMany({ orderBy: { date: "desc" } });
  return { expenses };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    await prisma.expense.create({
      data: {
        date: new Date(formData.get("date") as string),
        category: formData.get("category") as string,
        label: formData.get("label") as string,
        amount: parseFloat(formData.get("amount") as string),
        type: formData.get("type") as string,
        note: (formData.get("note") as string) || null,
      },
    });
  }

  if (intent === "delete") {
    await prisma.expense.delete({ where: { id: formData.get("id") as string } });
  }

  return null;
};

function eur(n: number) {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

export default function ExpensesPage() {
  const { expenses } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const byCategory = expenses.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + e.amount;
    return acc;
  }, {} as Record<string, number>);

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        .dw { padding: 36px 40px 60px; }
        @media (max-width: 640px) { .dw { padding: 16px 14px 48px; } }
        input, select, textarea, button { font-family: inherit; }
        input:focus, select:focus, textarea:focus { outline: 2px solid ${T.accent}; outline-offset: 2px; }
      `}</style>
      <div className="dw" style={{ minHeight: "100vh", background: T.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 8 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text, letterSpacing: "-0.02em" }}>Dépenses</h1>
              <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>
                {expenses.length} dépense{expenses.length > 1 ? "s" : ""} · Total {eur(total)}
              </p>
            </div>
            <a href="/app" style={{ fontSize: 11, color: T.muted, background: T.card, padding: "4px 10px", borderRadius: 99, border: `1px solid ${T.border}`, textDecoration: "none" }}>
              ← Dashboard
            </a>
          </div>

          {/* Résumé par catégorie */}
          {Object.keys(byCategory).length > 0 && (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 18px", boxShadow: T.shadow, marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, marginBottom: 10 }}>
                Total par catégorie
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {Object.entries(byCategory).map(([cat, amt]) => (
                  <div key={cat} style={{ background: T.redBg, border: `1px solid ${T.redBdr}`, borderRadius: 8, padding: "5px 12px", fontSize: 12 }}>
                    <span style={{ color: T.muted }}>{cat}</span>
                    <span style={{ fontWeight: 700, color: T.red, marginLeft: 8 }}>{eur(amt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Formulaire d'ajout */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: "20px 24px", boxShadow: T.shadow, marginBottom: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.dim, marginBottom: 14 }}>
              Ajouter une dépense
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="create" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 4 }}>Date</label>
                  <input type="date" name="date" required
                    defaultValue={new Date().toISOString().slice(0, 10)}
                    style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, color: T.text, background: "#fff" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 4 }}>Catégorie</label>
                  <select name="category" required
                    style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, color: T.text, background: "#fff" }}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 4 }}>Libellé</label>
                  <input type="text" name="label" required placeholder="Ex: Flyers pro"
                    style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, color: T.text, background: "#fff" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 4 }}>Montant (€)</label>
                  <input type="number" name="amount" required min="0" step="0.01" placeholder="0.00"
                    style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, color: T.text, background: "#fff" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 4 }}>Type</label>
                  <select name="type" required
                    style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, color: T.text, background: "#fff" }}>
                    <option value="ponctuelle">Ponctuelle</option>
                    <option value="mensuelle">Mensuelle</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 4 }}>Note (optionnel)</label>
                  <input type="text" name="note" placeholder="Détails…"
                    style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, color: T.text, background: "#fff" }} />
                </div>
              </div>
              <button type="submit" disabled={isSubmitting}
                style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 8, padding: "9px 22px", fontSize: 13, fontWeight: 600, cursor: isSubmitting ? "wait" : "pointer", opacity: isSubmitting ? 0.7 : 1 }}>
                {isSubmitting ? "Ajout…" : "Ajouter"}
              </button>
            </Form>
          </div>

          {/* Liste des dépenses */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow }}>
            {expenses.length === 0 ? (
              <div style={{ padding: "40px 24px", textAlign: "center", color: T.muted, fontSize: 13 }}>
                Aucune dépense enregistrée.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9" }}>
                      {["Date", "Catégorie", "Libellé", "Type", "Montant", "Note", ""].map(h => (
                        <th key={h} style={{ padding: "9px 14px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {expenses.map((e, i) => (
                      <tr key={e.id} style={{ borderTop: i > 0 ? `1px solid ${T.border}` : undefined, background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                        <td style={{ padding: "9px 14px", color: T.muted, whiteSpace: "nowrap" }}>
                          {new Date(e.date).toLocaleDateString("fr-FR")}
                        </td>
                        <td style={{ padding: "9px 14px" }}>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: "#eef2ff", color: T.accent }}>
                            {e.category}
                          </span>
                        </td>
                        <td style={{ padding: "9px 14px", color: T.text, fontWeight: 500 }}>{e.label}</td>
                        <td style={{ padding: "9px 14px" }}>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: e.type === "mensuelle" ? T.orangeBg : "#f1f5f9", color: e.type === "mensuelle" ? T.orange : T.muted }}>
                            {e.type}
                          </span>
                        </td>
                        <td style={{ padding: "9px 14px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {eur(e.amount)}
                        </td>
                        <td style={{ padding: "9px 14px", color: T.muted, fontSize: 12, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {e.note ?? "—"}
                        </td>
                        <td style={{ padding: "9px 14px" }}>
                          <Form method="post" style={{ display: "inline" }}>
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="id" value={e.id} />
                            <button type="submit"
                              style={{ background: "none", border: `1px solid ${T.redBdr}`, color: T.red, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
                              Suppr.
                            </button>
                          </Form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                      <td colSpan={4} style={{ padding: "9px 14px", fontWeight: 700, color: T.text }}>Total</td>
                      <td style={{ padding: "9px 14px", fontWeight: 800, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(total)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

        </div>
      </div>
    </>
  );
}
