import { useState } from "react";
import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseUgcProduit, DEFAULT_COSTS } from "../utils/ugc";
import type { UnitCosts } from "../utils/ugc";

// ─── Types ────────────────────────────────────────────────────────────────────

type Composant = "pot" | "cuillere" | "fouet" | "bol";
const COMPOSANTS: Composant[] = ["pot", "cuillere", "fouet", "bol"];
const COMPOSANT_LABELS: Record<Composant, string> = {
  pot:      "Pots",
  cuillere: "Cuillères",
  fouet:    "Fouets",
  bol:      "Bols",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeUnitCosts(
  achats: { composant: string; quantite: number; prixUnitaire: number }[]
): UnitCosts {
  const g: Record<string, { qty: number; cost: number }> = {};
  for (const a of achats) {
    if (!g[a.composant]) g[a.composant] = { qty: 0, cost: 0 };
    g[a.composant].qty  += a.quantite;
    g[a.composant].cost += a.quantite * a.prixUnitaire;
  }
  const avg = (k: string, fb: number) => (g[k]?.qty > 0 ? g[k].cost / g[k].qty : fb);
  return {
    pot:      avg("pot",      DEFAULT_COSTS.pot),
    fouet:    avg("fouet",    DEFAULT_COSTS.fouet),
    bol:      avg("bol",      DEFAULT_COSTS.bol),
    cuillere: avg("cuillere", DEFAULT_COSTS.cuillere),
  };
}

// ─── REST slim fetch for consumption ─────────────────────────────────────────

type RestLI = { title: string; quantity: number; price: string; variant_title: string | null };
type SlimLI = { title: string; variantTitle: string | null; quantity: number; unitPrice: number };

async function fetchOrdersLineItems(session: { shop: string; accessToken: string }): Promise<SlimLI[][]> {
  const all: SlimLI[][] = [];
  let url: string | null =
    `https://${session.shop}/admin/api/2026-07/orders.json?status=any&limit=250&fields=id,line_items`;
  while (url) {
    const resp: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": session.accessToken } });
    if (!resp.ok) break;
    const json = await resp.json() as { orders?: Array<{ line_items: RestLI[] }> };
    for (const o of json.orders ?? []) {
      all.push(o.line_items.map((li) => ({
        title: li.title, variantTitle: li.variant_title,
        quantity: li.quantity, unitPrice: parseFloat(li.price),
      })));
    }
    const link: string = resp.headers.get("Link") ?? "";
    const m: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return all;
}

function computeConsumption(orderItems: SlimLI[][]): Record<Composant, { sold: number; gifted: number }> {
  const out: Record<Composant, { sold: number; gifted: number }> = {
    pot:      { sold: 0, gifted: 0 },
    cuillere: { sold: 0, gifted: 0 },
    fouet:    { sold: 0, gifted: 0 },
    bol:      { sold: 0, gifted: 0 },
  };
  for (const items of orderItems) {
    for (const li of items) {
      const comps = parseUgcProduit(`${li.title} ${li.variantTitle ?? ""}`);
      const isGift = li.unitPrice <= 0.005;
      const add = (comp: Composant, n: number) => {
        if (n > 0) { if (isGift) out[comp].gifted += n; else out[comp].sold += n; }
      };
      add("pot",      comps.pots      * li.quantity);
      add("cuillere", comps.cuilleres * li.quantity);
      add("fouet",    comps.fouets    * li.quantity);
      add("bol",      comps.bols      * li.quantity);
    }
  }
  return out;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { session } = await authenticate.admin(request) as any;
  const sess = session as { shop: string; accessToken: string };

  const achats = await prisma.stockAchat.findMany({ orderBy: { createdAt: "desc" } });
  const unitCosts = computeUnitCosts(achats);

  let consumption: ReturnType<typeof computeConsumption> = {
    pot: { sold: 0, gifted: 0 }, cuillere: { sold: 0, gifted: 0 },
    fouet: { sold: 0, gifted: 0 }, bol: { sold: 0, gifted: 0 },
  };
  try {
    const items = await fetchOrdersLineItems(sess);
    consumption = computeConsumption(items);
  } catch { /* noop */ }

  // Purchase totals per composant
  const purchased: Record<string, { qty: number; cost: number }> = {};
  for (const a of achats) {
    if (!purchased[a.composant]) purchased[a.composant] = { qty: 0, cost: 0 };
    purchased[a.composant].qty  += a.quantite;
    purchased[a.composant].cost += a.coutTotal;
  }

  const stockRows = COMPOSANTS.map((comp) => {
    const p = purchased[comp] ?? { qty: 0, cost: 0 };
    const c = consumption[comp];
    const consumed = c.sold + c.gifted;
    const remaining = Math.max(0, p.qty - consumed);
    const unitCost  = unitCosts[comp];
    return {
      composant: comp,
      label:       COMPOSANT_LABELS[comp],
      qteAchetee:  p.qty,
      coutMoyen:   unitCost,
      coutTotal:   p.cost,
      qteSold:     c.sold,
      qteOffert:   c.gifted,
      qteConsumed: consumed,
      qteRestante: remaining,
      valeurStock: remaining * unitCost,
    };
  });

  const achatsList = achats.map((a) => ({
    id: a.id, date: a.date, composant: a.composant,
    fournisseur: a.fournisseur, quantite: a.quantite,
    prixUnitaire: a.prixUnitaire, coutTotal: a.coutTotal, notes: a.notes,
  }));

  const totalValeurStock = stockRows.reduce((s, r) => s + r.valeurStock, 0);
  const totalDepenseStock = stockRows.reduce((s, r) => s + r.coutTotal, 0);

  return { unitCosts, stockRows, achatsList, totalValeurStock, totalDepenseStock };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "").trim();

  if (intent === "create") {
    const composant    = String(form.get("composant")    ?? "").trim();
    const fournisseur  = String(form.get("fournisseur")  ?? "").trim() || null;
    const quantite     = parseInt(String(form.get("quantite") ?? "0"), 10);
    const prixUnitaire = parseFloat(String(form.get("prixUnitaire") ?? "0").replace(",", "."));
    const date         = String(form.get("date") ?? "").trim();
    const notes        = String(form.get("notes") ?? "").trim() || null;
    if (composant && quantite > 0 && prixUnitaire > 0 && date) {
      await prisma.stockAchat.create({
        data: { composant, fournisseur, quantite, prixUnitaire, coutTotal: quantite * prixUnitaire, date, notes },
      });
    }
  }

  if (intent === "delete") {
    const id = String(form.get("id") ?? "").trim();
    if (id) await prisma.stockAchat.delete({ where: { id } });
  }

  return null;
};

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg: "#F9F7F4", card: "#FFFFFF", border: "#EDE9E3",
  text: "#1C1917", muted: "#78716C", dim: "#A8A29E",
  accent: "#7C6FF7", accentBg: "#EEECFF",
  green: "#16A34A", greenBg: "#F0FDF4", greenBdr: "#86EFAC",
  amber: "#92400E", amberBg: "#FFFBEB", amberBdr: "#FDE68A",
  red: "#DC2626", redBg: "#FEF2F2", redBdr: "#FECACA",
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  shadow: "0 1px 3px rgba(28,25,23,0.07)",
};

const eur = (n: number) => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StockPage() {
  const { unitCosts, stockRows, achatsList, totalValeurStock, totalDepenseStock } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [showForm, setShowForm] = useState(false);

  const card: React.CSSProperties  = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: T.shadow };
  const th: React.CSSProperties    = { padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: T.dim, borderBottom: `1px solid ${T.border}`, background: T.bg, whiteSpace: "nowrap" as const };
  const inp: React.CSSProperties   = { width: "100%", padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, background: T.bg, color: T.text, fontFamily: T.font, boxSizing: "border-box" as const, outline: "none" };
  const lbl: React.CSSProperties   = { display: "flex", flexDirection: "column" as const, gap: 5 };
  const lbT: React.CSSProperties   = { fontSize: 11, fontWeight: 600, color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.06em" };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "28px 20px 80px", fontFamily: T.font, boxSizing: "border-box" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: T.text, letterSpacing: "-0.02em" }}>
              Marchandises & Stock
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: T.muted }}>
              Coûts unitaires, consommation réelle, valeur du stock restant
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={() => setShowForm((v) => !v)}
              style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 10, padding: "9px 18px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: T.font }}>
              {showForm ? "Annuler" : "+ Ajouter un achat"}
            </button>
            <a href="/app" style={{ fontSize: 12, color: T.muted, textDecoration: "none", padding: "7px 14px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.card, fontWeight: 500, display: "flex", alignItems: "center" }}>
              ← Dashboard
            </a>
          </div>
        </div>

        {/* KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
          {([
            { label: "Valeur stock restant",   value: eur(totalValeurStock),      color: T.green },
            { label: "Total investi en stock",  value: eur(totalDepenseStock),     color: T.text  },
            { label: "Coût pot (moy.)",         value: eur(unitCosts.pot),         color: T.muted },
            { label: "Coût fouet/bol (moy.)",   value: eur(unitCosts.fouet),       color: T.muted },
          ] as const).map(({ label, value, color }) => (
            <div key={label} style={{ ...card, padding: "14px 18px", borderRadius: 12 }}>
              <div style={{ fontSize: 11, color: T.dim, marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 19, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Coûts unitaires actuels */}
        <div style={{ ...card, padding: "14px 20px", marginBottom: 24, display: "flex", gap: 32, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>
            Coûts unitaires actifs
          </span>
          {(["pot", "cuillere", "fouet", "bol"] as const).map((comp) => (
            <div key={comp} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12, color: T.muted }}>{COMPOSANT_LABELS[comp]}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontVariantNumeric: "tabular-nums" }}>{eur(unitCosts[comp])}</span>
              {unitCosts[comp] === DEFAULT_COSTS[comp] && (
                <span style={{ fontSize: 10, color: T.dim, padding: "1px 5px", borderRadius: 99, border: `1px solid ${T.border}` }}>défaut</span>
              )}
            </div>
          ))}
        </div>

        {/* Form */}
        {showForm && (
          <div style={{ ...card, padding: "20px 24px", marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 16 }}>Enregistrer un achat de stock</div>
            <fetcher.Form method="post" onSubmit={() => setShowForm(false)}>
              <input type="hidden" name="intent" value="create" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                <label style={lbl}>
                  <span style={lbT}>Composant *</span>
                  <select name="composant" required style={inp}>
                    <option value="">Sélectionner…</option>
                    {COMPOSANTS.map((c) => <option key={c} value={c}>{COMPOSANT_LABELS[c]}</option>)}
                  </select>
                </label>
                <label style={lbl}>
                  <span style={lbT}>Date *</span>
                  <input name="date" type="date" required style={inp} />
                </label>
                <label style={lbl}>
                  <span style={lbT}>Fournisseur</span>
                  <input name="fournisseur" placeholder="ex: AliExpress" style={inp} />
                </label>
                <label style={lbl}>
                  <span style={lbT}>Quantité *</span>
                  <input name="quantite" type="number" min="1" required placeholder="ex: 100" style={inp} />
                </label>
                <label style={lbl}>
                  <span style={lbT}>Prix unitaire HT (€) *</span>
                  <input name="prixUnitaire" type="number" step="0.0001" min="0" required placeholder="ex: 3.77" style={inp} />
                </label>
                <label style={lbl}>
                  <span style={lbT}>Notes</span>
                  <input name="notes" placeholder="optionnel" style={inp} />
                </label>
              </div>
              <button type="submit" disabled={fetcher.state === "submitting"}
                style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 10, padding: "9px 20px", fontWeight: 600, fontSize: 13, cursor: "pointer", opacity: fetcher.state === "submitting" ? 0.6 : 1, fontFamily: T.font }}>
                {fetcher.state === "submitting" ? "Enregistrement…" : "Enregistrer"}
              </button>
            </fetcher.Form>
          </div>
        )}

        {/* Stock par composant */}
        <div style={{ ...card, overflow: "hidden", marginBottom: 24 }}>
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}` }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Stock par composant</span>
            <span style={{ marginLeft: 8, fontSize: 12, color: T.muted }}>consommation calculée depuis les commandes Shopify</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Composant", "Acheté", "Coût moyen", "Coût total", "Vendu", "Offert", "Consommé", "Restant", "Valeur stock"].map((h) => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stockRows.map((r) => (
                  <tr key={r.composant}
                    style={{ borderBottom: `1px solid ${T.border}` }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = T.bg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <td style={{ padding: "12px 14px", fontSize: 13, fontWeight: 600, color: T.text }}>{r.label}</td>
                    <td style={{ padding: "12px 14px", fontSize: 13, color: T.text, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{r.qteAchetee}</td>
                    <td style={{ padding: "12px 14px", fontSize: 12, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(r.coutMoyen)}</td>
                    <td style={{ padding: "12px 14px", fontSize: 12, color: T.red, fontVariantNumeric: "tabular-nums" }}>{r.coutTotal > 0 ? eur(r.coutTotal) : <span style={{ color: T.dim }}>—</span>}</td>
                    <td style={{ padding: "12px 14px", fontSize: 13, color: T.text, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{r.qteSold}</td>
                    <td style={{ padding: "12px 14px", fontSize: 12, color: T.amber, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{r.qteOffert > 0 ? r.qteOffert : <span style={{ color: T.dim }}>—</span>}</td>
                    <td style={{ padding: "12px 14px", fontSize: 13, color: T.text, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{r.qteConsumed}</td>
                    <td style={{ padding: "12px 14px" }}>
                      <span style={{
                        fontSize: 13, fontWeight: 700,
                        color: r.qteRestante <= 0 ? T.red : r.qteRestante < 20 ? T.amber : T.green,
                        fontVariantNumeric: "tabular-nums",
                      }}>
                        {r.qteRestante <= 0 ? "⚠ 0" : r.qteRestante}
                      </span>
                    </td>
                    <td style={{ padding: "12px 14px", fontSize: 13, fontWeight: 700, color: T.green, fontVariantNumeric: "tabular-nums" }}>
                      {r.valeurStock > 0 ? eur(r.valeurStock) : <span style={{ color: T.dim }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: T.bg, borderTop: `2px solid ${T.border}` }}>
                  <td colSpan={3} style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: T.muted }}>Total</td>
                  <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totalDepenseStock)}</td>
                  <td colSpan={4} />
                  <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 700, color: T.green, fontVariantNumeric: "tabular-nums" }}>{eur(totalValeurStock)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Historique des achats */}
        {achatsList.length > 0 && (
          <div style={{ ...card, overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Historique des achats</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Date", "Composant", "Fournisseur", "Quantité", "Prix unit.", "Total", "Notes", ""].map((h) => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {achatsList.map((a) => (
                    <tr key={a.id}
                      style={{ borderBottom: `1px solid ${T.border}` }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = T.bg; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <td style={{ padding: "10px 14px", fontSize: 12, color: T.muted, whiteSpace: "nowrap" }}>{a.date}</td>
                      <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: T.text }}>
                        {COMPOSANT_LABELS[a.composant as Composant] ?? a.composant}
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: T.muted }}>{a.fournisseur ?? "—"}</td>
                      <td style={{ padding: "10px 14px", fontSize: 13, color: T.text, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{a.quantite}</td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(a.prixUnitaire)}</td>
                      <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(a.coutTotal)}</td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: T.dim, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.notes ?? "—"}</td>
                      <td style={{ padding: "10px 14px" }}>
                        <fetcher.Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={a.id} />
                          <button type="submit"
                            style={{ background: "none", border: "none", cursor: "pointer", color: T.dim, fontSize: 14, padding: "2px 6px", borderRadius: 6, fontFamily: T.font }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = T.red; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = T.dim; }}
                          >✕</button>
                        </fetcher.Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {achatsList.length === 0 && (
          <div style={{ ...card, padding: "48px 20px", textAlign: "center" }}>
            <p style={{ margin: 0, fontSize: 14, color: T.muted }}>
              Aucun achat enregistré. Ajoutez vos achats pour calculer les coûts réels et la valeur du stock.
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 12, color: T.dim }}>
              Coûts par défaut utilisés : pot {eur(DEFAULT_COSTS.pot)} · cuillère {eur(DEFAULT_COSTS.cuillere)} · fouet {eur(DEFAULT_COSTS.fouet)} · bol {eur(DEFAULT_COSTS.bol)}
            </p>
          </div>
        )}

      </div>
    </div>
  );
}
