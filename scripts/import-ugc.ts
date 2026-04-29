/**
 * Import UGC depuis Laya_Gestion_Ecommerce_v10.xlsx
 * Sheet : COLLABS_INFLUENCEURS
 *
 * Logique dedup : contact (email/handle) en priorité, sinon nom exact.
 * Si l'entrée existe → mise à jour avec les données Excel (source de vérité).
 * Si elle n'existe pas → création.
 */

import { PrismaClient } from "@prisma/client";
import XLSX from "xlsx";

const prisma = new PrismaClient();

const EXCEL_PATH =
  process.env.HOME + "/Downloads/Laya_Gestion_Ecommerce_v10.xlsx";

function normalizeStatut(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (s.includes("terminé") || s.includes("fini") || s.includes("posté")) return "posté";
  if (s.includes("reçu")) return "reçu";
  return "envoyé"; // Actuel, Évènement, vide → envoyé par défaut
}

function normalizePays(raw: string): string {
  const s = raw.split(",")[0].trim().toLowerCase();
  if (s.includes("france")) return "France";
  if (s.includes("belg")) return "Belgique";
  if (s.includes("allem")) return "Allemagne";
  if (s.includes("suisse")) return "Suisse";
  return raw.split(",")[0].trim();
}

function toFloat(val: unknown): number | null {
  if (val === "" || val === null || val === undefined) return null;
  const n = parseFloat(String(val).replace(",", "."));
  return isNaN(n) ? null : n;
}

function toStr(val: unknown): string {
  return String(val ?? "").trim();
}

async function main() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets["COLLABS_INFLUENCEURS"];
  if (!ws) throw new Error("Sheet COLLABS_INFLUENCEURS not found");

  // header: 1 → tableau de tableaux, ligne 0 = titre, ligne 1 = vrais headers
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

  // Identifier la ligne header (celle qui contient "Nom")
  const hIdx = rows.findIndex((r) => Array.isArray(r) && r.some((c) => String(c).trim() === "Nom"));
  if (hIdx === -1) throw new Error("Ligne header non trouvée");

  const headers = (rows[hIdx] as unknown[]).map((h) => toStr(h));

  const col = (name: string) => headers.findIndex((h) => h.toLowerCase().includes(name.toLowerCase()));

  const iNom      = col("Nom");
  const iContact  = col("Contact");
  const iType     = col("Type");
  const iPlatf    = col("Plateforme");
  const iStatut   = col("Statut");
  const iTracking = col("N° colis");
  const iProduit  = col("Produits envoyés");
  const iPromo    = col("Code promo");
  const iPays     = col("Pays");
  const iFrais    = col("Coût livraison");
  const iDate     = col("Date livraison");
  const iCoutProd = col("Coût produit");
  const iCoutTotal = col("Coût total collab");

  console.log("Colonnes détectées :", {
    nom: iNom, contact: iContact, statut: iStatut, pays: iPays,
    frais: iFrais, coutProduit: iCoutProd, coutTotal: iCoutTotal,
  });

  const dataRows = rows.slice(hIdx + 1) as unknown[][];
  let created = 0, updated = 0, skipped = 0;

  for (const row of dataRows) {
    const nom = toStr(row[iNom]);
    if (!nom || nom.toLowerCase().startsWith("total")) continue; // skip vides et ligne TOTAL

    const contact      = toStr(row[iContact]);
    const pays         = normalizePays(toStr(row[iPays]));
    const produit      = toStr(row[iProduit]);
    const statut       = normalizeStatut(toStr(row[iStatut]));
    const trackingNumber = toStr(row[iTracking]) || null;
    const codePromo    = toStr(row[iPromo]).replace(/^aucun$/i, "") || null;
    const dateLivraison = toStr(row[iDate]) || null;
    const type         = toStr(row[iType]) || null;
    const plateforme   = toStr(row[iPlatf]) || null;
    const fraisPort    = toFloat(row[iFrais]) ?? 0;
    const coutProduit  = toFloat(row[iCoutProd]);
    const coutTotalCollab = toFloat(row[iCoutTotal]);

    // Dedup : contact d'abord (plus fiable), sinon nom — comparaison en JS (SQLite)
    const candidates = await prisma.creator.findMany({
      where: contact
        ? { contact: { not: null } }
        : { nom: { not: "" } },
      select: { id: true, nom: true, contact: true },
    });
    const existing = contact
      ? candidates.find((c) => c.contact?.toLowerCase().trim() === contact.toLowerCase().trim()) ?? null
      : candidates.find((c) => c.nom.toLowerCase().trim() === nom.toLowerCase().trim()) ?? null;

    const payload = {
      nom, instagram: contact, tiktok: "", contact: contact || null,
      type, plateforme, pays, produit, statut, fraisPort,
      trackingNumber, codePromo, dateLivraison, coutProduit, coutTotalCollab,
    };

    if (existing) {
      await prisma.creator.update({ where: { id: existing.id }, data: payload });
      console.log(`  🔄 update : ${nom}`);
      updated++;
    } else {
      await prisma.creator.create({ data: payload });
      console.log(`  ✅ create : ${nom} — ${pays} — ${produit} — ${fraisPort}€`);
      created++;
    }
  }

  console.log(`\n✔ Terminé : ${created} créé(s), ${updated} mis à jour, ${skipped} ignoré(s)`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
