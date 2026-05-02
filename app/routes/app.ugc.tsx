import { useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  parseUgcProduit, compsToKey, keyToComps, coutComps, coutFromKey,
  ugcShippingFromKey, ugcShippingFromText,
  PRODUIT_LABELS, TYPE_LABELS, PAYS_LABELS,
  SHIPPING_STATUTS_ACTIFS, SHIPPING_LABELS, shippingStyle,
  CONTENT_STATUTS, CONTENT_LABELS, contentStyle,
  normShippingStatus,
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
      if (ch === '"')              { inQ = !inQ; }
      else if (ch === sep && !inQ) { cells.push(cur.trim()); cur = ""; }
      else                         { cur += ch; }
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
  const t = raw.toLowerCase().split(",")[0].trim();
  if (t.includes("france")) return "FR";
  if (t.includes("belg"))   return "BE";
  if (t.includes("ital"))   return "IT";
  if (t.includes("portug")) return "PT";
  if (t.includes("allem") || t.includes("germany")) return "DE";
  if (t.includes("suisse") || t.includes("swiss"))  return "CH";
  return raw.toUpperCase().slice(0, 2);
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const creators = await prisma.creator.findMany({
    orderBy: { createdAt: "desc" },
    include: { todos: { orderBy: { createdAt: "asc" } } },
  });

  const totaux = creators.reduce(
    (acc, c) => {
      const refuse = c.shippingStatus === "refuse";
      return {
        // coûts : refusés exclus
        cogs:  acc.cogs  + (refuse ? 0 : (c.coutProduit ?? 0)),
        port:  acc.port  + (refuse ? 0 : c.fraisPort),
        total: acc.total + (refuse ? 0 : (c.coutTotalCollab ?? 0)),
        // shipping pipeline (actifs seulement)
        ship_en_attente:  acc.ship_en_attente  + (!refuse && c.shippingStatus === "en_attente"  ? 1 : 0),
        ship_preparation: acc.ship_preparation + (!refuse && c.shippingStatus === "preparation" ? 1 : 0),
        ship_envoye:      acc.ship_envoye      + (!refuse && c.shippingStatus === "envoye"      ? 1 : 0),
        ship_livre:       acc.ship_livre       + (!refuse && c.shippingStatus === "livre"       ? 1 : 0),
        ship_refuse:      acc.ship_refuse      + (refuse ? 1 : 0),
        // content pipeline (refusés exclus)
        cont_a_faire:     acc.cont_a_faire     + (!refuse && c.contentStatus  === "a_faire"     ? 1 : 0),
        cont_recu:        acc.cont_recu        + (!refuse && c.contentStatus  === "recu"        ? 1 : 0),
        cont_poste:       acc.cont_poste       + (!refuse && c.contentStatus  === "poste"       ? 1 : 0),
      };
    },
    { cogs: 0, port: 0, total: 0,
      ship_en_attente: 0, ship_preparation: 0, ship_envoye: 0, ship_livre: 0, ship_refuse: 0,
      cont_a_faire: 0, cont_recu: 0, cont_poste: 0 },
  );

  return { creators, totaux };
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

  if (intent === "update_tracking") {
    const id             = form.get("id") as string;
    const trackingNumber = (form.get("trackingNumber") as string) || null;
    await prisma.creator.update({ where: { id }, data: { trackingNumber } });
    return null;
  }

  if (intent === "create") {
    const produit  = form.get("produit") as string;
    const pays     = form.get("pays") as string;
    const quantite = parseInt(form.get("quantite") as string, 10) || 1;
    const cp       = coutFromKey(produit, quantite);
    const port     = parseFloat(form.get("fraisPort") as string) || ugcShippingFromKey(pays, produit, quantite);
    const nom      = (form.get("nom") as string).trim();

    const creator = await prisma.creator.create({
      data: {
        nom,
        instagram:      (form.get("instagram") as string).trim(),
        tiktok:         (form.get("tiktok") as string) || "",
        type:           form.get("type") as string,
        plateforme:     "Réseaux sociaux",
        pays,
        produit,
        quantite,
        statut:         "en_attente",
        shippingStatus: (form.get("shippingStatus") as string) || "en_attente",
        contentStatus:  "a_faire",
        fraisPort:      port,
        trackingNumber: (form.get("trackingNumber") as string) || null,
        codePromo:      (form.get("codePromo") as string) || null,
        dateLivraison:  (form.get("dateLivraison") as string) || null,
        notes:          (form.get("notes") as string) || null,
        coutProduit:    cp,
        coutTotalCollab: cp + port,
      },
    });
    await prisma.todo.createMany({
      data: [
        { title: `Préparer colis — ${nom}`,          creatorId: creator.id },
        { title: `Envoyer colis — ${nom}`,            creatorId: creator.id },
        { title: `Ajouter numéro de suivi — ${nom}`, creatorId: creator.id },
        { title: `Relancer ${nom} pour le contenu`,  creatorId: creator.id },
        { title: `Poster le contenu de ${nom}`,      creatorId: creator.id },
      ],
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
      const shipping = normShippingStatus(row.statutRaw ?? "");

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
          statut:         shipping,
          shippingStatus: shipping,
          contentStatus:  "a_faire",
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
const cell: React.CSSProperties = { padding: "8px 10px", color: "#0f172a" };

// ─── Mini todo ────────────────────────────────────────────────────────────────

function TodoMini({ todo, creatorNom }: { todo: { id: string; title: string; done: boolean }; creatorNom: string }) {
  const fetcher = useFetcher();
  const optimisticDone = fetcher.formData?.get("intent") === "toggle" ? !todo.done : todo.done;
  const label = todo.title
    .replace(` — ${creatorNom}`, "")
    .replace(`${creatorNom} `, "")
    .replace(` de ${creatorNom}`, "")
    .trim();

  return (
    <li style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 0" }}>
      <fetcher.Form method="post" action="/app/todo" style={{ display: "contents" }}>
        <input type="hidden" name="intent" value="toggle" />
        <input type="hidden" name="id" value={todo.id} />
        <input type="hidden" name="done" value={String(todo.done)} />
        <button type="submit" style={{
          width: 15, height: 15, borderRadius: 4, flexShrink: 0, cursor: "pointer",
          border: optimisticDone ? "none" : "1.5px solid #cbd5e1",
          background: optimisticDone ? T.green : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
        }}>
          {optimisticDone && (
            <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
              <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </fetcher.Form>
      <span style={{ fontSize: 12, color: optimisticDone ? T.dim : T.muted, textDecoration: optimisticDone ? "line-through" : "none" }}>
        {label}
      </span>
    </li>
  );
}

// ─── Row créateur ─────────────────────────────────────────────────────────────

type CreatorData = {
  id: string; nom: string; instagram: string; type: string | null;
  pays: string; produit: string; fraisPort: number;
  trackingNumber: string | null; coutProduit: number | null;
  coutTotalCollab: number | null; notes: string | null;
  shippingStatus: string; contentStatus: string;
  todos: { id: string; title: string; done: boolean }[];
};

function CreatorRow({ c, i }: { c: CreatorData; i: number }) {
  const [showTodos, setShowTodos] = useState(false);
  const shipFetcher    = useFetcher();
  const contFetcher    = useFetcher();
  const trackFetcher   = useFetcher();
  const refuseFetcher  = useFetcher();
  const deleteFetcher  = useFetcher();

  const currentShipping = (shipFetcher.formData?.get("shippingStatus") as string)
    ?? (refuseFetcher.formData?.get("shippingStatus") as string)
    ?? c.shippingStatus;
  const currentContent  = (contFetcher.formData?.get("contentStatus")  as string) ?? c.contentStatus;

  const isRefuse = currentShipping === "refuse";
  const { color: shipColor, background: shipBg }  = shippingStyle(currentShipping);
  const { color: contColor, background: contBg }  = contentStyle(currentContent);

  const typeLabel  = TYPE_LABELS[c.type ?? ""] ?? c.type ?? "—";
  const comps      = keyToComps(c.produit, 1);
  const doneTodos  = c.todos.filter(t => t.done).length;
  const totalTodos = c.todos.length;

  const rowBg    = isRefuse ? "#fef2f2" : i % 2 === 0 ? "#fff" : "#f8fafc";
  const dimColor = isRefuse ? "#fca5a5" : undefined;

  const selectStyle = (bg: string, color: string): React.CSSProperties => ({
    ...inp, width: "auto", fontSize: 11, padding: "3px 6px",
    background: bg, color, fontWeight: 700, cursor: "pointer",
  });

  function submitShipping(val: string) {
    refuseFetcher.submit(
      { id: c.id, shippingStatus: val },
      { method: "POST", action: "/app/api/creator-statut" },
    );
  }

  return (
  <>
    <tr style={{ borderTop: `1px solid ${T.border}`, background: rowBg, opacity: isRefuse ? 0.75 : 1 }}>

      {/* Nom */}
      <td style={{ ...cell, fontWeight: 600, minWidth: 120 }}>
        <div style={{ color: isRefuse ? T.muted : T.text }}>{c.nom}</div>
        {c.instagram && <div style={{ fontSize: 11, color: T.dim }}>{c.instagram}</div>}
      </td>

      {/* Type */}
      <td style={cell}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 99,
          background: isRefuse ? "#f9fafb" : "#eef2ff", color: isRefuse ? T.muted : T.accent }}>
          {typeLabel}
        </span>
      </td>

      {/* Pays */}
      <td style={{ ...cell, color: T.muted }}>{PAYS_LABELS[c.pays] ?? c.pays}</td>

      {/* Produit */}
      <td style={cell}>
        <div style={{ fontSize: 12, color: isRefuse ? T.muted : T.text }}>{PRODUIT_LABELS[c.produit] ?? c.produit}</div>
        <div style={{ fontSize: 11, color: T.dim }}>{fmtComps(comps)}</div>
      </td>

      {/* Coûts — grisés si refusé */}
      <td style={{ ...cell, color: isRefuse ? T.dim : T.muted, fontVariantNumeric: "tabular-nums", textDecoration: isRefuse ? "line-through" : "none" }}>
        {eur(c.fraisPort)}
      </td>
      <td style={{ ...cell, color: isRefuse ? T.dim : T.red, fontWeight: 600, fontVariantNumeric: "tabular-nums", textDecoration: isRefuse ? "line-through" : "none" }}>
        {eur(c.coutProduit ?? 0)}
      </td>
      <td style={{ ...cell, color: isRefuse ? T.dim : T.red, fontWeight: 700, fontVariantNumeric: "tabular-nums", textDecoration: isRefuse ? "line-through" : "none" }}>
        {eur(c.coutTotalCollab ?? 0)}
      </td>

      {/* Statut colis */}
      <td style={cell}>
        {isRefuse ? (
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 99,
            background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5" }}>
            Refusé
          </span>
        ) : (
          <select
            value={currentShipping}
            onChange={e => shipFetcher.submit(
              { id: c.id, shippingStatus: e.target.value },
              { method: "POST", action: "/app/api/creator-statut" },
            )}
            style={selectStyle(shipBg, shipColor)}
          >
            {SHIPPING_STATUTS_ACTIFS.map(s => <option key={s} value={s}>{SHIPPING_LABELS[s]}</option>)}
          </select>
        )}
      </td>

      {/* Statut contenu — masqué si refusé */}
      <td style={cell}>
        {isRefuse ? (
          <span style={{ fontSize: 11, color: T.dim }}>—</span>
        ) : (
          <select
            value={currentContent}
            onChange={e => contFetcher.submit(
              { id: c.id, contentStatus: e.target.value },
              { method: "POST", action: "/app/api/creator-statut" },
            )}
            style={selectStyle(contBg, contColor)}
          >
            {CONTENT_STATUTS.map(s => <option key={s} value={s}>{CONTENT_LABELS[s]}</option>)}
          </select>
        )}
      </td>

      {/* Tracking — masqué si refusé */}
      <td style={{ ...cell, minWidth: 200 }}>
        {!isRefuse && (
          <trackFetcher.Form method="post" style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <input type="hidden" name="intent" value="update_tracking" />
            <input type="hidden" name="id" value={c.id} />
            <input name="trackingNumber" defaultValue={c.trackingNumber ?? ""} placeholder="N° suivi…"
              style={{ ...inp, width: 140, fontSize: 12, padding: "3px 7px" }} />
            <button type="submit"
              style={{ background: T.accent, color: "#fff", border: "none", borderRadius: 7, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
              ✓
            </button>
          </trackFetcher.Form>
        )}
      </td>

      {/* Notes */}
      <td style={{ ...cell, color: T.muted, fontSize: 11, maxWidth: 140, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {c.notes ?? "—"}
      </td>

      {/* Tâches */}
      <td style={cell}>
        {!isRefuse && totalTodos > 0 ? (
          <button type="button" onClick={() => setShowTodos(v => !v)} style={{
            background: "none", border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "3px 9px", fontSize: 11, cursor: "pointer", fontWeight: 600,
            color: doneTodos === totalTodos ? T.green : T.muted, whiteSpace: "nowrap",
          }}>
            {doneTodos}/{totalTodos} {showTodos ? "▲" : "▼"}
          </button>
        ) : <span style={{ color: T.dim, fontSize: 11 }}>—</span>}
      </td>

      {/* Actions : Refusé + Supprimer */}
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          {/* Bouton Refusé / Réactiver */}
          {isRefuse ? (
            <button type="button"
              onClick={() => submitShipping("en_attente")}
              style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #e2e8f0",
                background: "#f1f5f9", color: T.muted, cursor: "pointer", fontWeight: 600 }}>
              Réactiver
            </button>
          ) : (
            <button type="button"
              onClick={() => submitShipping("refuse")}
              style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #fca5a5",
                background: "#fef2f2", color: "#dc2626", cursor: "pointer", fontWeight: 600 }}>
              Refusé
            </button>
          )}
          {/* Bouton Supprimer */}
          <deleteFetcher.Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="id" value={c.id} />
            <button type="submit"
              style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #fca5a5",
                background: "none", color: "#ef4444", cursor: "pointer", fontWeight: 600 }}>
              Supprimer
            </button>
          </deleteFetcher.Form>
        </div>
      </td>
    </tr>

    {showTodos && !isRefuse && totalTodos > 0 && (
      <tr style={{ background: "#f8fafc" }}>
        <td colSpan={13} style={{ padding: "8px 16px 12px 24px", borderBottom: `1px solid ${T.border}` }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: "2px 24px" }}>
            {c.todos.map(t => <TodoMini key={t.id} todo={t} creatorNom={c.nom} />)}
          </ul>
        </td>
      </tr>
    )}
  </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UGCPage() {
  const { creators, totaux } = useLoaderData<typeof loader>();
  const nav        = useNavigation();
  const csvFetcher = useFetcher<{ importResult: string }>();
  const fileRef    = useRef<HTMLInputElement>(null);
  const [csvPreview, setCsvPreview] = useState<CsvRow[] | null>(null);
  const submitting = nav.state === "submitting";

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCsvPreview(parseCsv(ev.target?.result as string));
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
      <div style={{ maxWidth: 1160, margin: "0 auto" }}>

        {/* VERSION BANNER — à supprimer une fois confirmé */}
        <div style={{ background: "#fbbf24", color: "#1c1917", fontWeight: 700, fontSize: 13, padding: "8px 16px", borderRadius: 8, marginBottom: 16, letterSpacing: "0.05em" }}>
          ✓ VERSION UGC STATUTS SEPARES (colis + contenu)
        </div>

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
                    {["Nom", "Pays", "Produit brut", "→ Clé", "Composants", "Port calculé", "Statut colis"].map(h => (
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
                        <td style={{ padding: "6px 10px", color: T.muted }}>{normShippingStatus(r.statutRaw ?? "")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={confirmImport} disabled={csvFetcher.state === "submitting"}
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
            <div style={{ fontSize: 24, fontWeight: 700, color: T.text }}>{creators.length - totaux.ship_refuse}</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
              {totaux.ship_livre} livrés · {totaux.cont_poste} postés
              {totaux.ship_refuse > 0 && <span style={{ color: "#dc2626", marginLeft: 6 }}>· {totaux.ship_refuse} refusé{totaux.ship_refuse > 1 ? "s" : ""}</span>}
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

        {/* Pipeline double */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
          {/* Pipeline colis */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 18px", boxShadow: T.shadow }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: T.dim, letterSpacing: "0.08em", marginBottom: 10 }}>
              Pipeline colis
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {(["en_attente", "preparation", "envoye", "livre"] as const).map((s, idx, arr) => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ ...shippingStyle(s), borderRadius: 99, padding: "3px 12px", fontSize: 12, fontWeight: 700, display: "inline-block" }}>
                      {totaux[`ship_${s}` as keyof typeof totaux]}
                    </div>
                    <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>{SHIPPING_LABELS[s]}</div>
                  </div>
                  {idx < arr.length - 1 && <span style={{ color: T.dim, fontSize: 14, marginBottom: 14 }}>→</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Pipeline contenu */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 18px", boxShadow: T.shadow }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: T.dim, letterSpacing: "0.08em", marginBottom: 10 }}>
              Pipeline contenu
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {(["a_faire", "recu", "poste"] as const).map((s, idx, arr) => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ ...contentStyle(s), borderRadius: 99, padding: "3px 12px", fontSize: 12, fontWeight: 700, display: "inline-block" }}>
                      {totaux[`cont_${s}` as keyof typeof totaux]}
                    </div>
                    <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>{CONTENT_LABELS[s]}</div>
                  </div>
                  {idx < arr.length - 1 && <span style={{ color: T.dim, fontSize: 14, marginBottom: 14 }}>→</span>}
                </div>
              ))}
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
              <label style={lbl}><span style={lbT}>Statut colis</span>
                <select name="shippingStatus" defaultValue="en_attente" style={inp}>
                  {SHIPPING_STATUTS_ACTIFS.map(s => <option key={s} value={s}>{SHIPPING_LABELS[s]}</option>)}
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
              <label style={lbl}><span style={lbT}>Notes</span>
                <input name="notes" placeholder="ex: 2 vidéos, contrat..." style={inp} />
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
                    {["Nom", "Type", "Pays", "Produit / Comps", "Port", "COGS", "Total", "Colis", "Contenu", "N° suivi", "Notes", "Tâches", ""].map(h => (
                      <th key={h} style={{ padding: "10px 10px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {creators.map((c, i) => <CreatorRow key={c.id} c={c} i={i} />)}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#f1f5f9", borderTop: `2px solid ${T.border}` }}>
                    <td colSpan={4} style={{ padding: "10px 10px", fontWeight: 700, color: T.text }}>Total</td>
                    <td style={{ padding: "10px 10px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.port)}</td>
                    <td style={{ padding: "10px 10px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.cogs)}</td>
                    <td style={{ padding: "10px 10px", fontWeight: 700, color: T.red, fontVariantNumeric: "tabular-nums" }}>{eur(totaux.total)}</td>
                    <td colSpan={6} />
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
