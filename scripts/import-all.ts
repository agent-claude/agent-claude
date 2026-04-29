/**
 * Import complet depuis Laya_Gestion_Ecommerce_v10.xlsx
 * Sheets : ACHATS_MARCHANDISE, VENTES, DEPENSES_ANNEXES, COLLABS_INFLUENCEURS
 */

import { PrismaClient } from "@prisma/client";
import XLSX from "xlsx";

const prisma = new PrismaClient();
const FILE = process.env.HOME + "/Downloads/Laya_Gestion_Ecommerce_v10.xlsx";

function toF(v: unknown): number {
  const n = parseFloat(String(v ?? "").replace(",", ".").trim());
  return isNaN(n) ? 0 : n;
}
function toFN(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(",", ".").trim());
  return isNaN(n) ? null : n;
}
function toS(v: unknown): string { return String(v ?? "").trim(); }
function toI(v: unknown): number { return Math.round(toF(v)); }

function getRows(wb: XLSX.WorkBook, sheetName: string) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" introuvable`);
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
}

function findHeaderRow(rows: unknown[][], keyCol: string): number {
  return rows.findIndex(r =>
    Array.isArray(r) && r.some(c => toS(c).toLowerCase().includes(keyCol.toLowerCase()))
  );
}

// ── ACHATS ──────────────────────────────────────────────────────────────────
async function importAchats(wb: XLSX.WorkBook) {
  const rows = getRows(wb, "ACHATS_MARCHANDISE");
  const hIdx = findHeaderRow(rows, "Date commande");
  const h = (rows[hIdx] as unknown[]).map(toS);
  const c = (n: string) => h.findIndex(x => x.toLowerCase().includes(n.toLowerCase()));

  const iDate = c("Date commande");
  const iNum  = c("N° commande");
  const iFou  = c("Fournisseur");
  const iProd = c("Produit");
  const iFmt  = c("Format");
  const iQty  = c("Quantité");
  const iPrix = c("Prix unitaire");
  const iFrL  = c("Frais livraison");
  const iFrD  = c("Frais douane");
  const iAut  = c("Autres frais");
  const iHT   = c("Coût total HT");
  const iTVA  = c("TVA");
  const iTTC  = c("Coût total TTC");
  const iRec  = c("Date réception");
  const iStat = c("Statut");

  let created = 0, skipped = 0;
  for (const row of (rows.slice(hIdx + 1) as unknown[][])) {
    const dateCommande = toS(row[iDate]);
    const produit      = toS(row[iProd]);
    if (!dateCommande || !produit || produit.startsWith("TOTAL") || produit.startsWith("📦")) continue;

    const existing = await prisma.achat.findFirst({
      where: { numeroCommande: toS(row[iNum]), produit },
    });
    if (existing) { skipped++; continue; }

    await prisma.achat.create({ data: {
      dateCommande,
      numeroCommande: toS(row[iNum]),
      fournisseur:    toS(row[iFou]),
      produit,
      format:         toS(row[iFmt]),
      quantite:       toI(row[iQty]),
      prixUnitaireHT: toF(row[iPrix]),
      fraisLivraison: toF(row[iFrL]),
      fraisDouane:    toF(row[iFrD]),
      autresFrais:    toF(row[iAut]),
      coutTotalHT:    toF(row[iHT]),
      tva:            toF(row[iTVA]),
      coutTotalTTC:   toF(row[iTTC]),
      dateReception:  toS(row[iRec]) || null,
      statut:         toS(row[iStat]),
    }});
    console.log(`  ✅ Achat : ${produit} x${toI(row[iQty])} — ${toF(row[iTTC])}€`);
    created++;
  }
  console.log(`  → ${created} créé(s), ${skipped} ignoré(s)\n`);
}

// ── VENTES ───────────────────────────────────────────────────────────────────
async function importVentes(wb: XLSX.WorkBook) {
  const rows = getRows(wb, "VENTES");
  const hIdx = findHeaderRow(rows, "Date vente");
  const h = (rows[hIdx] as unknown[]).map(toS);
  const c = (n: string) => h.findIndex(x => x.toLowerCase().includes(n.toLowerCase()));

  const iDate  = c("Date vente");
  const iNum   = c("N° commande");
  const iCanal = c("Canal");
  const iPays  = c("Pays");
  const iProd  = c("Produit vendu");
  const iFmt   = c("Format");
  const iQty   = c("Quantité");
  const iPrix  = c("Prix vente");
  const iRem   = c("Remise");
  const iNet   = c("Prix net");
  const iTVA   = c("TVA");
  const iEnc   = c("Prix encaissé");
  const iFrCl  = c("Frais livraison client");
  const iFrRl  = c("Coût livraison réel");
  const iCProd = c("Coût produit");
  const iCPub  = c("Coût pub");
  const iMB    = c("Marge brute");
  const iMN    = c("Marge nette");
  const iStat  = c("Statut");

  let created = 0, skipped = 0;
  for (const row of (rows.slice(hIdx + 1) as unknown[][])) {
    const dateVente      = toS(row[iDate]);
    const numeroCommande = toS(row[iNum]);
    if (!dateVente || !numeroCommande || numeroCommande.startsWith("TOTAL") || numeroCommande.startsWith("ℹ")) continue;

    const existing = await prisma.vente.findUnique({ where: { numeroCommande } });
    if (existing) { skipped++; continue; }

    await prisma.vente.create({ data: {
      dateVente,
      numeroCommande,
      canalVente:          toS(row[iCanal]),
      pays:                toS(row[iPays]),
      produitVendu:        toS(row[iProd]),
      format:              toS(row[iFmt]),
      quantite:            toI(row[iQty]),
      prixVente:           toF(row[iPrix]),
      remise:              toF(row[iRem]),
      prixNet:             toF(row[iNet]),
      tva:                 toF(row[iTVA]),
      prixEncaisse:        toF(row[iEnc]),
      fraisLivraisonClient:toF(row[iFrCl]),
      coutLivraisonReel:   toF(row[iFrRl]),
      coutProduit:         toF(row[iCProd]),
      coutPub:             toF(row[iCPub]),
      margeBrute:          toF(row[iMB]),
      margeNette:          toF(row[iMN]),
      statut:              toS(row[iStat]),
    }});
    console.log(`  ✅ Vente : ${numeroCommande} — ${toS(row[iProd])} — ${toF(row[iEnc])}€`);
    created++;
  }
  console.log(`  → ${created} créé(s), ${skipped} ignoré(s)\n`);
}

// ── DÉPENSES ────────────────────────────────────────────────────────────────
async function importDepenses(wb: XLSX.WorkBook) {
  const rows = getRows(wb, "DEPENSES_ANNEXES");
  const hIdx = findHeaderRow(rows, "Date");
  const h = (rows[hIdx] as unknown[]).map(toS);
  const c = (n: string) => h.findIndex(x => x.toLowerCase().includes(n.toLowerCase()));

  const iDate  = c("Date");
  const iCat   = c("Catégorie");
  const iDesc  = c("Description");
  const iFou   = c("Fournisseur");
  const iHT    = c("Montant HT");
  const iTVA   = c("TVA");
  const iTTC   = c("Montant TTC");
  const iMoy   = c("Moyen de paiement");
  const iMois  = c("Mois comptable");
  const iNotes = c("Notes");

  let created = 0, skipped = 0;
  for (const row of (rows.slice(hIdx + 1) as unknown[][])) {
    const date        = toS(row[iDate]);
    const description = toS(row[iDesc]);
    if (!date || !description || description.startsWith("TOTAL") || description.startsWith("ℹ")) continue;

    const existing = await prisma.depense.findFirst({ where: { date, description } });
    if (existing) { skipped++; continue; }

    await prisma.depense.create({ data: {
      date,
      categorie:     toS(row[iCat]),
      description,
      fournisseur:   toS(row[iFou]),
      montantHT:     toF(row[iHT]),
      tva:           toF(row[iTVA]),
      montantTTC:    toF(row[iTTC]),
      moyenPaiement: toS(row[iMoy]),
      moisComptable: toS(row[iMois]),
      notes:         toS(row[iNotes]) || null,
    }});
    console.log(`  ✅ Dépense : ${toS(row[iCat])} — ${description} — ${toF(row[iTTC])}€`);
    created++;
  }
  console.log(`  → ${created} créé(s), ${skipped} ignoré(s)\n`);
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const wb = XLSX.readFile(FILE);

  console.log("\n📦 ACHATS_MARCHANDISE");
  await importAchats(wb);

  console.log("💜 VENTES");
  await importVentes(wb);

  console.log("📊 DEPENSES_ANNEXES");
  await importDepenses(wb);

  // Récap
  const [achats, ventes, depenses, creators] = await Promise.all([
    prisma.achat.aggregate({ _sum: { coutTotalTTC: true }, _count: true }),
    prisma.vente.aggregate({ _sum: { prixEncaisse: true, margeBrute: true }, _count: true }),
    prisma.depense.aggregate({ _sum: { montantTTC: true }, _count: true }),
    prisma.creator.aggregate({ _sum: { coutTotalCollab: true }, _count: true }),
  ]);

  console.log("━".repeat(50));
  console.log("📊 RÉSUMÉ BASE DE DONNÉES");
  console.log(`  Achats     : ${achats._count} lignes — coût total ${achats._sum.coutTotalTTC?.toFixed(2)}€`);
  console.log(`  Ventes     : ${ventes._count} lignes — CA ${ventes._sum.prixEncaisse?.toFixed(2)}€ — marge brute ${ventes._sum.margeBrute?.toFixed(2)}€`);
  console.log(`  Dépenses   : ${depenses._count} lignes — total ${depenses._sum.montantTTC?.toFixed(2)}€`);
  console.log(`  Créateurs  : ${creators._count} — coût UGC ${creators._sum.coutTotalCollab?.toFixed(2)}€`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
