import { useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type Pays = "France" | "Belgique" | "Allemagne" | "Suisse";
type Produit = "1 pot" | "2 pots" | "3 pots" | "Kit Découverte" | "Kit Ultime";
type Statut = "envoyé" | "reçu" | "posté";

const PAYS: Pays[] = ["France", "Belgique", "Allemagne", "Suisse"];
const PRODUITS: Produit[] = ["1 pot", "2 pots", "3 pots", "Kit Découverte", "Kit Ultime"];
const STATUTS: Statut[] = ["envoyé", "reçu", "posté"];

// Colonnes CSV → champs Creator
const CSV_MAP: Record<string, string> = {
  "Nom Prénom":              "nom",
  "E-mail ou insta":         "contact",
  "UGC / Influence":         "type",
  "Plateforme":              "plateforme",
  "Statut":                  "statut",
  "numéro du colis":         "trackingNumber",
  "kit ou produits envoyés": "produit",
  "code promo":              "codePromo",
  "Pays":                    "pays",
  "Coût de livraison":       "fraisPort",
  "Livré":                   "dateLivraison",
};

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Auto-détection séparateur (comma vs semicolon)
  const sep = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";

  function splitRow(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === sep && !inQ) { cells.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    cells.push(cur.trim());
    return cells;
  }

  const rawHeaders = splitRow(lines[0]);
  const headers = rawHeaders.map((h) => h.replace(/^"|"$/g, "").trim());

  return lines.slice(1).map((line) => {
    const vals = splitRow(line);
    const obj: CsvRow = {};
    headers.forEach((h, i) => {
      const field = CSV_MAP[h];
      if (field) obj[field] = (vals[i] ?? "").replace(/^"|"$/g, "").trim();
    });
    return obj;
  }).filter((row) => row.nom && row.nom.trim());
}

function getShippingCost(pays: string, produit: string): number {
  if (pays === "France") {
    if (produit === "3 pots") return 7.59;
    if (produit === "Kit Ultime") return 9.29;
    return 5.49;
  }
  if (pays === "Belgique") {
    if (produit === "Kit Ultime") return 6.60;
    return 4.60;
  }
  if (pays === "Allemagne") {
    if (produit === "Kit Ultime") return 13.80;
    return 12.50;
  }
  if (produit === "Kit Ultime") return 19.39;
  return 14.99;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const creators = await prisma.creator.findMany({ orderBy: { createdAt: "desc" } });
  return { creators };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const data = await request.formData();
  const intent = String(data.get("intent"));

  if (intent === "create") {
    const pays = String(data.get("pays"));
    const produit = String(data.get("produit"));
    const lienVideoRaw = String(data.get("lienVideo") ?? "").trim();
    await prisma.creator.create({
      data: {
        nom: String(data.get("nom")),
        instagram: String(data.get("instagram")),
        tiktok: String(data.get("tiktok")),
        pays,
        produit,
        statut: String(data.get("statut")),
        fraisPort: getShippingCost(pays, produit),
        lienVideo: lienVideoRaw || null,
      },
    });
  }

  if (intent === "delete") {
    await prisma.creator.delete({ where: { id: String(data.get("id")) } });
  }

  if (intent === "updateStatut") {
    await prisma.creator.update({
      where: { id: String(data.get("id")) },
      data: { statut: String(data.get("statut")) },
    });
  }

  if (intent === "importCsv") {
    let imported = 0;
    let skipped = 0;
    const rows: CsvRow[] = JSON.parse(String(data.get("rows") ?? "[]"));

    for (const row of rows) {
      if (!row.nom) continue;
      const existing = await prisma.creator.findFirst({
        where: { nom: row.nom, contact: row.contact || null },
      });
      if (existing) { skipped++; continue; }

      // Frais de port : CSV si présent, sinon calcul
      const csvFrais = parseFloat(String(row.fraisPort ?? "").replace(",", "."));
      const fraisPort = !isNaN(csvFrais) && csvFrais > 0
        ? csvFrais
        : getShippingCost(row.pays ?? "", row.produit ?? "");

      await prisma.creator.create({
        data: {
          nom: row.nom,
          instagram: row.contact || "",
          tiktok: "",
          contact: row.contact || null,
          type: row.type || null,
          plateforme: row.plateforme || null,
          pays: row.pays || "",
          produit: row.produit || "",
          statut: row.statut || "envoyé",
          fraisPort,
          trackingNumber: row.trackingNumber || null,
          codePromo: row.codePromo || null,
          dateLivraison: row.dateLivraison || null,
        },
      });
      imported++;
    }
    return { importResult: `${imported} importé(s), ${skipped} déjà présent(s).` };
  }

  return null;
};

type CreatorRow = {
  id: string;
  nom: string;
  instagram: string;
  tiktok: string;
  contact: string | null;
  type: string | null;
  plateforme: string | null;
  pays: string;
  produit: string;
  statut: string;
  fraisPort: number;
  lienVideo: string | null;
  trackingNumber: string | null;
  codePromo: string | null;
  dateLivraison: string | null;
};

function Row({ creator }: { creator: CreatorRow }) {
  const fetcher = useFetcher();
  const currentStatut = String(fetcher.formData?.get("statut") ?? creator.statut);
  const display = creator.contact || creator.instagram || "—";

  return (
    <tr>
      <td style={td}>{creator.nom}</td>
      <td style={td}>{display}</td>
      <td style={td}>{creator.type || "—"}</td>
      <td style={td}>{creator.plateforme || "—"}</td>
      <td style={td}>{creator.pays}</td>
      <td style={td}>{creator.produit}</td>
      <td style={td}>
        <select
          value={currentStatut}
          onChange={(e) =>
            fetcher.submit(
              { intent: "updateStatut", id: creator.id, statut: e.target.value },
              { method: "post" }
            )
          }
          style={{ fontSize: 13, padding: "2px 4px" }}
        >
          {STATUTS.map((s) => <option key={s}>{s}</option>)}
        </select>
      </td>
      <td style={td}>{creator.fraisPort.toFixed(2)} €</td>
      <td style={td}>{creator.trackingNumber || "—"}</td>
      <td style={td}>
        {creator.lienVideo ? (
          <a href={creator.lienVideo} target="_blank" rel="noreferrer" style={{ color: "#0070f3" }}>Voir</a>
        ) : "—"}
      </td>
      <td style={td}>
        <button
          type="button"
          onClick={() => fetcher.submit({ intent: "delete", id: creator.id }, { method: "post" })}
          style={{ fontSize: 13, cursor: "pointer", color: "#c00", background: "none", border: "1px solid #c00", borderRadius: 4, padding: "2px 8px" }}
        >
          Supprimer
        </button>
      </td>
    </tr>
  );
}

export default function UGC() {
  const { creators } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const csvFetcher = useFetcher<{ importResult: string }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csvPreview, setCsvPreview] = useState<CsvRow[] | null>(null);

  const [nom, setNom] = useState("");
  const [instagram, setInstagram] = useState("");
  const [tiktok, setTiktok] = useState("");
  const [pays, setPays] = useState<Pays>("France");
  const [produit, setProduit] = useState<Produit>("1 pot");
  const [statut, setStatut] = useState<Statut>("envoyé");
  const [lienVideo, setLienVideo] = useState("");

  function addCreator() {
    if (!nom) return;
    fetcher.submit(
      { intent: "create", nom, instagram, tiktok, pays, produit, statut, lienVideo },
      { method: "post" }
    );
    setNom(""); setInstagram(""); setTiktok("");
    setPays("France"); setProduit("1 pot"); setStatut("envoyé"); setLienVideo("");
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCsv(text);
      setCsvPreview(rows);
    };
    reader.readAsText(file, "UTF-8");
  }

  function confirmCsvImport() {
    if (!csvPreview) return;
    csvFetcher.submit(
      { intent: "importCsv", rows: JSON.stringify(csvPreview) },
      { method: "post" }
    );
    setCsvPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // Optimistic UI : affiche la nouvelle ligne immédiatement pendant la sauvegarde
  const isCreating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "create";
  const optimistic: CreatorRow | null = isCreating
    ? {
        id: "__optimistic__",
        nom:       String(fetcher.formData!.get("nom") ?? ""),
        instagram: String(fetcher.formData!.get("instagram") ?? ""),
        tiktok:    String(fetcher.formData!.get("tiktok") ?? ""),
        contact:   null, type: null, plateforme: null,
        pays:    String(fetcher.formData!.get("pays") ?? ""),
        produit: String(fetcher.formData!.get("produit") ?? ""),
        statut:  String(fetcher.formData!.get("statut") ?? "envoyé"),
        fraisPort: getShippingCost(
          String(fetcher.formData!.get("pays") ?? ""),
          String(fetcher.formData!.get("produit") ?? ""),
        ),
        lienVideo: String(fetcher.formData!.get("lienVideo") ?? "") || null,
        trackingNumber: null, codePromo: null, dateLivraison: null,
      }
    : null;

  const displayed = optimistic ? [optimistic, ...creators] : creators;
  const totalShipping = displayed.reduce((sum, c) => sum + c.fraisPort, 0);
  const inputStyle = { padding: 8, fontSize: 14, width: "100%" };

  return (
    <div style={{ padding: 40 }}>
      {/* En-tête */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>UGC</h1>

        {/* Import CSV */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
          padding: "7px 14px", fontSize: 14, background: "#f1f1f1", border: "1px solid #ccc", borderRadius: 4 }}>
          📂 Importer CSV
          <input ref={fileRef} type="file" accept=".csv" onChange={handleFileChange} style={{ display: "none" }} />
        </label>

        {csvFetcher.data?.importResult && (
          <span style={{ fontSize: 13, color: "#108043" }}>{csvFetcher.data.importResult}</span>
        )}
      </div>

      {/* Prévisualisation CSV */}
      {csvPreview && (
        <div style={{ marginBottom: 24, padding: 16, background: "#f9fafb", border: "1px solid #e4e5e7", borderRadius: 6 }}>
          <p style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>
            {csvPreview.length} ligne(s) détectée(s) — vérifiez avant d'importer :
          </p>
          <div style={{ overflowX: "auto", maxHeight: 200, overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>{["Nom", "Contact", "Pays", "Produit", "Statut", "Frais"].map((h) =>
                  <th key={h} style={{ ...th, fontSize: 12 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {csvPreview.map((r, i) => (
                  <tr key={i}>
                    <td style={td}>{r.nom}</td>
                    <td style={td}>{r.contact || "—"}</td>
                    <td style={td}>{r.pays || "—"}</td>
                    <td style={td}>{r.produit || "—"}</td>
                    <td style={td}>{r.statut || "—"}</td>
                    <td style={td}>{r.fraisPort || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button type="button" onClick={confirmCsvImport}
              disabled={csvFetcher.state === "submitting"}
              style={{ padding: "7px 16px", fontSize: 13, cursor: "pointer", background: "#008060", color: "#fff", border: "none", borderRadius: 4 }}>
              {csvFetcher.state === "submitting" ? "Import…" : "Confirmer l'import"}
            </button>
            <button type="button" onClick={() => { setCsvPreview(null); if (fileRef.current) fileRef.current.value = ""; }}
              style={{ padding: "7px 16px", fontSize: 13, cursor: "pointer", background: "none", border: "1px solid #ccc", borderRadius: 4 }}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* Formulaire manuel */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 320 }}>
        <input placeholder="Nom *" value={nom} onChange={(e) => setNom(e.target.value)} style={inputStyle} />
        <input placeholder="Instagram" value={instagram} onChange={(e) => setInstagram(e.target.value)} style={inputStyle} />
        <input placeholder="TikTok" value={tiktok} onChange={(e) => setTiktok(e.target.value)} style={inputStyle} />
        <select value={pays} onChange={(e) => setPays(e.target.value as Pays)} style={inputStyle}>
          {PAYS.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={produit} onChange={(e) => setProduit(e.target.value as Produit)} style={inputStyle}>
          {PRODUITS.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={statut} onChange={(e) => setStatut(e.target.value as Statut)} style={inputStyle}>
          {STATUTS.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input placeholder="Lien vidéo" value={lienVideo} onChange={(e) => setLienVideo(e.target.value)} style={inputStyle} />
        <div style={{ fontSize: 13, color: "#555" }}>
          Frais de port : {getShippingCost(pays, produit).toFixed(2)} €
        </div>
        <button type="button" onClick={addCreator} style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer" }}>
          Ajouter
        </button>
      </div>

      {/* Tableau */}
      {creators.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
            Total frais de port : {totalShipping.toFixed(2)} €
          </p>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Liste des créateurs :</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  {["Nom", "Contact", "Type", "Plateforme", "Pays", "Produit", "Statut",
                    "Frais de port", "Tracking", "Lien vidéo", "Action"].map((h) => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {creators.map((c) => <Row key={c.id} creator={c} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const td: React.CSSProperties = { padding: "6px 12px", whiteSpace: "nowrap" };
const th: React.CSSProperties = { textAlign: "left", padding: "6px 12px", borderBottom: "2px solid #ccc", whiteSpace: "nowrap" };
