import { useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  parseUgcProduit, compsToKey, keyToComps, coutComps, coutFromKey,
  ugcShippingFromKey, ugcShippingFromText,
  PRODUIT_LABELS, TYPE_LABELS, PAYS_LABELS,
  STATUTS, STATUT_LABELS, statutStyle, normStatut,
  eur, fmtComps,
} from "../utils/ugc";

// ─── CSV parsing ──────────────────────────────────────────────────────────────

const CSV_MAP: Record<string, string> = {
  "Nom Prénom":              "nom",
  "E-mail ou insta":         "instagram",
  "UGC / Influence":         "type",
  "Plateforme":              "plateforme",
  "Statut":                  "statutRaw",
  "numéro du colis":         "trackingNumber",
  "kit ou produits envoyés": "produitRaw",
  "code promo":              "codePromo",
  "Pays":                    "paysRaw",
  "Coût de livraison":       "fraisPortRaw",
  "Livré":                   "dateLivraison",
};

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";

  function splitRow(line: string): string[] {
    const cells: string[] = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"')          { inQ = !inQ; }
      else if (ch === sep && !inQ) { cells.push(cur.trim()); cur = ""; }
      else                     { cur += ch; }
    }
    cells.push(cur.trim());
    return cells;
  }

  const headers = splitRow(lines[0]).map(h => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map(line => {
    const vals = splitRow(line);
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      const field = CSV_MAP[h];
      if (field) row[field] = (vals[i] ?? "").replace(/^"|"$/g, "").trim();
    });
    return row;
  }).filter(r => r.nom?.trim());
}

function normPays(raw: string): string {
  const t = raw.toLowerCase().split(",")[0].trim(); // "france, bordeaux" → "france"
  if (t.includes("france")) return "FR";
  if (t.includes("belg"))   return "BE";
  if (t.includes("ital"))   return "IT";
  if (t.includes("portug")) return "PT";
  if (t.includes("allem") || t.includes("germany")) return "DE";
  if (t.includes("suisse") || t.includes("swiss"))  return "CH";
  return raw.toUpperCase().slice(0, 2); // fallback : 2 premières lettres
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const creators = await prisma.creator.findMany({ orderBy: { createdAt: "desc" } });
  const totaux = creators.reduce(
    (acc, c) => {
      const ns = normStatut(c.statut);
      return {
        cogs:        acc.cogs  + (c.coutProduit ?? 0),
        port:        acc.port  + c.fraisPort,
        total:       acc.total + (c.coutTotalCollab ?? 0),
        preparation: acc.preparation + (ns === "preparation" ? 1 : 0),
        envoye:      acc.envoye      + (ns === "envoye"      ? 1 : 0),
        poste:       acc.poste       + (ns === "poste"       ? 1 : 0),
        recu:        acc.recu        + (ns === "recu"        ? 1 : 0),
        publie:      acc.publie      + (ns === "publie"      ? 1 : 0),
        en_attente:  acc.en_attente  + (ns === "en_attente"  ? 1 : 0),
      };
    },
    { cogs: 0, port: 0, total: 0, preparation: 0, envoye: 0, poste: 0, recu: 0, publie: 0, en_attente: 0 },
  );
  const pctPublie = creators.length > 0 ? Math.round((totaux.publie / creators.length) * 100) : 0;
  return { creators, totaux, pctPublie };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form   = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "delete") {
    await prisma.creator.delete({ where: { id: form.get("id") as string } });
    return null;
  }

  if (intent === "update_statut") {
    const trackingNumber = (form.get("trackingNumber") as string) || null;
    const rawStatut      = form.get("statut") as string;
    // Auto-avancer à "envoye" si un numéro de suivi est saisi et qu'on est en preparation
    const statut = (trackingNumber && rawStatut === "preparation") ? "envoye" : rawStatut;
    await prisma.creator.update({
      where: { id: form.get("id") as string },
      data: { statut, trackingNumber },
    });
    return null;
  }

  if (intent === "create") {
    const produit  = form.get("produit") as string;
    const pays     = form.get("pays") as string;
    const quantite = parseInt(form.get("quantite") as string, 10) || 1;
    const cp       = coutFromKey(produit, quantite);
    const port     = parseFloat(form.get("fraisPort") as string) || ugcShippingFromKey(pays, produit, quantite);

    await prisma.creator.create({
      data: {
        nom:            (form.get("nom") as string).trim(),
        instagram:      (form.get("instagram") as string).trim(),
        tiktok:         (form.get("tiktok") as string) || "",
        type:           form.get("type") as string,
        plateforme:     "Réseaux sociaux",
        pays,
        produit,
        quantite,
        statut:         (form.get("statut") as string) || "preparation",
        fraisPort:      port,
        trackingNumber: (form.get("trackingNumber") as string) || null,
        codePromo:      (form.get("codePromo") as string) || null,
        dateLivraison:  (form.get("dateLivraison") as string) || null,
        notes:          (form.get("notes") as string) || null,
        coutProduit:    cp,
        coutTotalCollab: cp + port,
      },
    });
    return null;
  }

  if (intent === "import_csv") {
    const rows: CsvRow[] = JSON.parse(form.get("rows") as string);
    let imported = 0;

    for (const row of rows) {
      const pays     = normPays(row.paysRaw ?? "");
      const comps    = parseUgcProduit(row.produitRaw ?? "");
      const produit  = compsToKey(comps);
      const cp       = coutComps(comps);
      const csvPort  = parseFloat((row.fraisPortRaw ?? "").replace(",", "."));
      const port     = !isNaN(csvPort) && csvPort > 0 ? csvPort : ugcShippingFromText(pays, row.produitRaw ?? "");
      const statut   = normStatut(row.statutRaw ?? "");

      await prisma.creator.create({
        data: {
          nom:            row.nom.trim(),
          instagram:      row.instagram || "",
          tiktok:         "",
          type:           row.type?.toLowerCase().trim() || null,
          plateforme:     row.plateforme || null,
          pays,
          produit,
          quantite:       1,
          statut,
          fraisPort:      port,
          trackingNumber: row.trackingNumber || null,
          codePromo:      row.codePromo || null,
          dateLivraison:  row.dateLivraison || null,
            coutProduit:    cp,
          coutTotalCollab: cp + port,
        },
      });
      imported++;
    }
    return { importResult: `${imported} créateur(s) importé(s)` };
  }

  return null;
};

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", dim: "#94a3b8", accent: "#6366f1",
  green: "#059669", greenBg: "#f0fdf4",
  orange: "#d97706", orangeBg: "#fffbeb",
  red: "#dc2626", redBg: "#fef2f2", redBdr: "#fca5a5",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
};

const inp: React.CSSProperties = {
  border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px",
  fontSize: 13, width: "100%", boxSizing: "border-box", background: "#fff",
};
const lbl: React.CSSProperties  = { display: "flex", flexDirection: "column", gap: 5 };
const lbT: React.CSSProperties  = { fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em" };
const cell: React.CSSProperties = { padding: "8px 12px", color: "#0f172a" };

// ─── Composant Row éditable ───────────────────────────────────────────────────

function CreatorRow({ c, i }: {
  c: { id: string; nom: string; instagram: string; type: string | null; pays: string; produit: string;
       statut: string; fraisPort: number; trackingNumber: string | null; coutProduit: number | null;
       coutTotalCollab: number | null; notes: string | null; };
  i: number;
}) {
  const fetcher     = useFetcher();
  const statut      = String(fetcher.formData?.get("statut") ?? c.statut);
  const { color: statutColor, background: statutBg } = statutStyle(statut);
  const typeLabel   = TYPE_LABELS[c.type ?? ""] ?? c.type ?? "—";
  const comps       = keyToComps(c.produit, 1);

  return (
    <tr style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
      <td style={{ ...cell, fontWeight: 600 }}>
        <div>{c.nom}</div>
        {c.instagram && <div style={{ fontSize: 11, color: T.muted }}>{c.instagram}</div>}
      </td>
      <td style={cell}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 99, background: "#eef2ff", color: T.accent }}>
          {typeLabel}
        </span>
      </td>
      <td style={{ ...cell, color: T.muted }}>{PAYS_LABELS[c.pays] ?? c.pays}</td>
      <td style={cell}>
        <div style={{ fontSize: 12 }}>{PRODUIT_LABELS[c.produit] ?? c.produit}</div>
        <div style={{ fontSize: 11, color: T.muted }}>{fmtComps(comps)}</div>
      </td>
      <td style={{ ...cell, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{eur(c.fraisPort)}</td>
      <td style={{ ...cell, color: T.red, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{eur(c.coutProduit ?? 0)}</td>
      <td style={{ ...cell, color: T.red, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{eur(c.coutTotalCollab ?? 0)}</td>
      {/* Statut + tracking inline */}
      <td style={{ ...cell, minWidth: 300 }}>
        <fetcher.Form method="post" style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input type="hidden" name="intent" value="update_statut" />
          <input type="hidden" name="id" value={c.id} />
          <select name="statut" defaultValue={normStatut(c.statut)}
            style={{ ...inp, width: "auto", fontSize: 12, padding: "3px 7px", background: statutBg, color: statutColor, fontWeight: 700 }}>
            {STATUTS.map(s => (
              <option key={s} value={s}>{STATUT_LABELS[s]}</option>
            ))}
          </select>
          <input name="trackingNumber" defaultValue={c.trackingNumber ?? ""} placeholder="N° suivi…"
            style={{ ...inp, width: 140, fontSize: 12, padding: "3px 7px" }} />
          <button type="submit"
            style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 7, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
            ✓
          </button>
        </fetcher.Form>
      </td>
      <td style={{ ...cell, fontSize: 11, color: c.trackingNumber ? T.text : T.dim, fontVariantNumeric: "tabular-nums" }}>
        {c.trackingNumber ?? "—"}
      </td>
      <td style={{ ...cell, color: T.muted, fontSize: 11, maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {c.notes ?? "—"}
      </td>
      <td style={cell}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={c.id} />
          <button type="submit" style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 13, padding: "2px 6px" }}>✕</button>
        </fetcher.Form>
      </td>
    </tr>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UGCPage() {
  const { creators, totaux, pctPublie } = useLoaderData<typeof loader>();
  const nav        = useNavigation();
  const csvFetcher = useFetcher<{ importResult: string }>();
  const fileRef    = useRef<HTMLInputElement>(null);
  const [csvPreview, setCsvPreview] = useState<CsvRow[] | null>(null);
  const submitting = nav.state === "submitting";

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const rows = parseCsv(ev.target?.result as string);
      setCsvPreview(rows);
    };
    reader.readAsText(file, "UTF-8");
  }

  function confirmImport() {
    if (!csvPreview) return;
    csvFetcher.submit({ intent: "import_csv", rows: JSON.stringify(csvPreview) }, { method: "post" });
    setCsvPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "32px 24px 60px",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', boxSizing: "border-box" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 8 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: T.text }}>UGC & Collabs</h1>
            <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>Créateurs · Influenceurs · Cafés · Partenariats</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ fontSize: 11, color: T.muted, background: "#f1f5f9", border: `1px solid ${T.border}`,
              padding: "4px 12px", borderRadius: 8, cursor: "pointer" }}>
              Importer CSV
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFileChange} style={{ display: "none" }} />
            </label>
            <a href="/app" style={{ fontSize: 12, color: T.accent, textDecoration: "none", border: "1px solid #c7d2fe", padding: "4px 12px", borderRadius: 8 }}>
              ← Dashboard
            </a>
          </div>
        </div>

        {/* Résultat import */}
        {csvFetcher.data?.importResult && (
          <div style={{ background: T.greenBg, border: "1px solid #86efac", borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, color: T.green, fontWeight: 600 }}>
            ✓ {csvFetcher.data.importResult}
          </div>
        )}

        {/* Prévisualisation CSV */}
        {csvPreview && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, marginBottom: 24, boxShadow: T.shadow }}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: T.muted, marginBottom: 12 }}>
              {csvPreview.length} ligne(s) détectée(s) — aperçu parsing
            </div>
            <div style={{ overflowX: "auto", maxHeight: 200, marginBottom: 14 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["Nom", "Pays", "Produit brut", "→ Clé", "Composants", "Port calculé", "Statut"].map(h => (
                      <th key={h} style={{ padding: "7px 10px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvPreview.map((r, i) => {
                    const pays   = normPays(r.paysRaw ?? "");
                    const comps  = parseUgcProduit(r.produitRaw ?? "");
                    const key    = compsToKey(comps);
                    const port   = ugcShippingFromText(pays, r.produitRaw ?? "");
                    return (
                      <tr key={i} style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                        <td style={{ padding: "6px 10px" }}>{r.nom}</td>
                        <td style={{ padding: "6px 10px", color: T.muted }}>{pays}</td>
                        <td style={{ padding: "6px 10px", color: T.muted, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.produitRaw}</td>
                        <td style={{ padding: "6px 10px" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: "#eef2ff", color: T.accent }}>{key}</span>
                        </td>
                        <td style={{ padding: "6px 10px", fontSize: 11, color: T.green }}>{fmtComps(comps)}</td>
                        <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums" }}>{eur(port)}</td>
                        <td style={{ padding: "6px 10px", color: T.muted }}>{normStatut(r.statutRaw ?? "")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={confirmImport}
                disabled={csvFetcher.state === "submitting"}
                style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 9, padding: "9px 18px", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
                {csvFetcher.state === "submitting" ? "Import…" : "Confirmer l'import"}
              </button>
              <button type="button" onClick={() => { setCsvPreview(null); if (fileRef.current) fileRef.current.value = ""; }}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 9, padding: "9px 18px", fontSize: 13, cursor: "pointer" }}>
                Annuler
              </button>
            </div>
          </div>
        )}

        {/* KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 18px", boxShadow: T.shadow }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4 }}>Total créateurs</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.text }}>{creators.length}</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
              {totaux.publie} publiés · {pctPublie}% taux publication
            </div>
          </div>
          <div style={{ background: T.redBg, border: `1px solid ${T.redBdr}`, borderRadius: 14, padding: "16px 18px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4 }}>COGS produits</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.cogs)}</div>
          </div>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 18px", boxShadow: T.shadow }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4 }}>Livraison</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.port)}</div>
          </div>
          <div style={{ background: T.redBg, border: `1px solid ${T.redBdr}`, borderRadius: 14, padding: "16px 18px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4 }}>Total UGC</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.total)}</div>
          </div>
        </div>

        {/* Pipeline statuts */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 18px", marginBottom: 24, boxShadow: T.shadow }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: T.dim, letterSpacing: "0.08em", marginBottom: 10 }}>Pipeline</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {(["preparation","envoye","poste","recu","publie"] as const).map((s, idx, arr) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ ...statutStyle(s), borderRadius: 99, padding: "3px 12px", fontSize: 11, fontWeight: 700, display: "inline-block" }}>
                    {totaux[s]}
                  </div>
                  <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>{STATUT_LABELS[s]}</div>
                </div>
                {idx < arr.length - 1 && <span style={{ color: T.dim, fontSize: 14, marginBottom: 14 }}>→</span>}
              </div>
            ))}
            {totaux.en_attente > 0 && (
              <>
                <span style={{ color: T.dim, fontSize: 12, margin: "0 4px", marginBottom: 14 }}>|</span>
                <div style={{ textAlign: "center" }}>
                  <div style={{ ...statutStyle("en_attente"), borderRadius: 99, padding: "3px 12px", fontSize: 11, fontWeight: 700, display: "inline-block" }}>
                    {totaux.en_attente}
                  </div>
                  <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>{STATUT_LABELS["en_attente"]}</div>
                </div>
              </>
            )}
            <div style={{ marginLeft: "auto", textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#047857" }}>{pctPublie}%</div>
              <div style={{ fontSize: 10, color: T.dim }}>publiés</div>
            </div>
          </div>
        </div>

        {/* Formulaire ajout */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 24, marginBottom: 28, boxShadow: T.shadow }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.muted, marginBottom: 16 }}>
            Ajouter un créateur
          </div>
          <form method="post" action="/app/ugc">
            <input type="hidden" name="intent" value="create" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12 }}>
              <label style={lbl}><span style={lbT}>Nom *</span>
                <input name="nom" required placeholder="Nom Prénom / Marque" style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>Instagram / Email</span>
                <input name="instagram" placeholder="@handle ou email" style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>TikTok</span>
                <input name="tiktok" placeholder="@handle" style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>Type</span>
                <select name="type" required style={inp}>
                  {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label style={lbl}><span style={lbT}>Pays</span>
                <select name="pays" required style={inp}>
                  {Object.entries(PAYS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label style={lbl}><span style={lbT}>Produit</span>
                <select name="produit" required style={inp}>
                  {Object.entries(PRODUIT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label style={lbl}><span style={lbT}>Qté</span>
                <input name="quantite" type="number" min="1" defaultValue="1" style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>Statut</span>
                <select name="statut" defaultValue="preparation" style={inp}>
                  {STATUTS.map(s => (
                    <option key={s} value={s}>{STATUT_LABELS[s]}</option>
                  ))}
                </select>
              </label>
              <label style={lbl}><span style={lbT}>Frais port (auto si vide)</span>
                <input name="fraisPort" type="number" step="0.01" placeholder="calculé auto" style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>N° suivi</span>
                <input name="trackingNumber" placeholder="LP: 5Y00..." style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>Code promo</span>
                <input name="codePromo" placeholder="ex: ANAIS10" style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>Date livraison</span>
                <input name="dateLivraison" type="date" style={inp} />
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <label style={lbl}><span style={lbT}>N° suivi (Colissimo, Mondial Relay…)</span>
                <input name="trackingNumber" placeholder="ex: 1A00123456789" style={inp} />
              </label>
              <label style={lbl}><span style={lbT}>Notes</span>
                <input name="notes" placeholder="ex: 2 vidéos, contrat à faire..." style={inp} />
              </label>
            </div>
            <button type="submit" disabled={submitting} style={{
              background: T.accent, color: "#fff", border: "none", borderRadius: 10,
              padding: "10px 20px", fontWeight: 600, fontSize: 13, cursor: "pointer",
              opacity: submitting ? 0.6 : 1,
            }}>
              {submitting ? "Enregistrement..." : "Ajouter"}
            </button>
          </form>
        </div>

        {/* Table créateurs */}
        {creators.length > 0 && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["Nom", "Type", "Pays", "Produit / Comps", "Port", "COGS", "Total", "Statut / N° suivi", "Tracking", "Notes", ""].map(h => (
                      <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {creators.map((c, i) => <CreatorRow key={c.id} c={c} i={i} />)}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                    <td colSpan={4} style={{ padding: "10px 12px", fontWeight: 700, color: T.text }}>Total</td>
                    <td style={{ padding: "10px 12px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.port)}</td>
                    <td style={{ padding: "10px 12px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.cogs)}</td>
                    <td style={{ padding: "10px 12px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.total)}</td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}


