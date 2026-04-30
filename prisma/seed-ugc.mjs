// npx node --env-file=.env prisma/seed-ugc.mjs
// Importe les 15 créateurs depuis les données brutes du CSV des-2/1.csv
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COUT = { pot: 3.77055, fouet: 4.1806, bol: 4.1806, cuillere: 2.40 };

// ─── Parser texte libre → composants ─────────────────────────────────────────

function norm(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[''`]/g, "").trim();
}

function parseUgcProduit(text) {
  const t = norm(text);

  if (t.includes("kit ultime") || t.includes("kit complet") || t.includes("kit ultimate")) {
    return { pots: 1, fouets: 1, bols: 1, cuilleres: 0 };
  }
  if (t.includes("kit decouverte") || t.includes("kit découverte")) {
    return { pots: 1, fouets: 1, bols: 0, cuilleres: 0 };
  }

  let pots = 0, fouets = 0, bols = 0, cuilleres = 0;

  const qtyPot = t.match(/(\d+)\s*(?:x\s*)?(?:pot|poudre|laya)/);
  if (qtyPot) {
    pots = parseInt(qtyPot[1], 10);
  } else if (t.includes("pot") || t.includes("poudre") || t.includes("laya")) {
    pots = 1;
  }

  if (t.includes("cuillere") || t.includes("cuilliere") || t.includes("spoon") || t.includes("cuiller")) {
    cuilleres = 1;
  }
  if (t.includes("fouet"))  fouets = 1;
  if (t.includes("bol"))    bols   = 1;

  return { pots, fouets, bols, cuilleres };
}

function compsToKey(c) {
  if (c.bols > 0 && c.fouets > 0 && c.pots > 0)              return "kit_ultime";
  if (c.fouets > 0 && c.pots > 0 && !c.bols && !c.cuilleres) return "kit_decouverte";
  if (c.pots > 0 && c.fouets > 0 && c.cuilleres > 0)         return "pot_fouet_cuillere";
  if (c.pots > 0 && c.cuilleres > 0)                         return "pot_cuillere";
  if (c.pots >= 3)  return "3_pots";
  if (c.pots >= 2)  return "2_pots";
  if (c.pots === 1) return "pot";
  if (c.fouets > 0) return "fouet";
  if (c.bols > 0)   return "bol";
  if (c.cuilleres > 0) return "cuillere";
  return "pot";
}

function coutComps(c) {
  return c.pots * COUT.pot + c.fouets * COUT.fouet + c.bols * COUT.bol + c.cuilleres * COUT.cuillere;
}

function ugcShipping(pays, comps) {
  const isUltime = comps.bols > 0;
  const is3pots  = comps.pots >= 3 && !isUltime;
  switch (pays.toUpperCase()) {
    case "FR": return isUltime ? 9.29 : is3pots ? 7.59 : 5.49;
    case "BE": return isUltime ? 6.60 : 4.60;
    case "IT":
    case "PT": return isUltime ? 9.50 : 6.60;
    case "DE": return isUltime ? 13.80 : 12.50;
    case "CH": return isUltime ? 19.39 : 14.99;
    default:   return 0;
  }
}

// ─── Données brutes du CSV (col "kit ou produits envoyés" intacte) ────────────

const RAW = [
  { nom: "Florida",           instagram: "hello.rydacreates@gmail.com", tiktok: "",               type: "ugc",       pays: "FR", produitRaw: "poudre, spoon",                              fraisPortCsv: 4.10,  statut: "posté",  trackingNumber: "MR: 17211543", dateLivraison: "2026-03-06" },
  { nom: "Anais",             instagram: "nanivoyage@myyahoo.com",       tiktok: "",               type: "ugc",       pays: "FR", produitRaw: "Kit complet",                                fraisPortCsv: 5.99,  statut: "posté",  trackingNumber: "MR: 17211541", codePromo: "ANAIS10", dateLivraison: "2026-03-07" },
  { nom: "Tifenn",            instagram: "tifenn.u@gmail.com",           tiktok: "",               type: "ugc",       pays: "FR", produitRaw: "Kit complet",                                fraisPortCsv: 5.99,  statut: "posté",  trackingNumber: "MR: 17211542", dateLivraison: "2026-03-07" },
  { nom: "Flore Waite",       instagram: "flore.waite@gmail.com",        tiktok: "",               type: "ugc",       pays: "FR", produitRaw: "Kit complet",                                fraisPortCsv: 5.99,  statut: "envoyé", trackingNumber: "MR: 17587204" },
  { nom: "Jeanne Fompeyrine", instagram: "jeanne.fompeyrine@orange.fr",  tiktok: "",               type: "ugc",       pays: "FR", produitRaw: "Pot laya 100g + cuillère",                   fraisPortCsv: 4.10,  statut: "posté",  trackingNumber: "MR: 17587206", dateLivraison: "2026-04-02" },
  { nom: "Julie",             instagram: "@jujulvdrr",                   tiktok: "@jujulvdrr",     type: "influence", pays: "FR", produitRaw: "Kit complet",                                fraisPortCsv: 9.59,  statut: "envoyé", trackingNumber: "LP: 5Y00559397231", dateLivraison: "2026-03-31" },
  { nom: "Selona",            instagram: "@byselo_",                     tiktok: "@byselo_",       type: "influence", pays: "CH", produitRaw: "Kit complet + sirop vanille + lapin au chocolat", fraisPortCsv: null, statut: "posté" },
  { nom: "Margot Bassouler",  instagram: "@callmegogomar",               tiktok: "@callmegogomar", type: "influence", pays: "FR", produitRaw: "Pot laya 100g + cuillère + fouet",            fraisPortCsv: 7.59,  statut: "posté",  trackingNumber: "LP: 5Y00559607231" },
  { nom: "Yousra Tachfine",   instagram: "@tiistis",                     tiktok: "@tiistis",       type: "influence", pays: "FR", produitRaw: "Pot laya 100g + cuillère",                   fraisPortCsv: 5.49,  statut: "envoyé", trackingNumber: "LP: 5Y00559607217" },
  { nom: "Sila Kocabas",      instagram: "@brewla.Bar",                  tiktok: "",               type: "influence", pays: "DE", produitRaw: "Pot laya 100g",                              fraisPortCsv: 12.50, statut: "envoyé", trackingNumber: "MR: 17681747" },
  { nom: "Define Studio",     instagram: "Coucou",                       tiktok: "",               type: "cafe",      pays: "FR", produitRaw: "Kit complet",                                fraisPortCsv: 7.59,  statut: "posté",  trackingNumber: "LP: 5Y00558100825", dateLivraison: "2026-03-23" },
  { nom: "TADAM CAFÉ",        instagram: "Tadamcafé",                    tiktok: "",               type: "cafe",      pays: "FR", produitRaw: "Pot laya 100g",                              fraisPortCsv: 5.49,  statut: "envoyé", trackingNumber: "LP: 5Y00558100832", dateLivraison: "2026-03-25" },
  { nom: "MOM COFFEE SHOP",   instagram: "mom coffee shop",              tiktok: "",               type: "cafe",      pays: "FR", produitRaw: "Pot laya 100g",                              fraisPortCsv: 5.49,  statut: "envoyé", trackingNumber: "LP: 8J02192147747" },
  { nom: "YERA COFFEE",       instagram: "yera coffee shop",             tiktok: "",               type: "cafe",      pays: "FR", produitRaw: "Pot laya 100g",                              fraisPortCsv: 5.49,  statut: "envoyé", trackingNumber: "LP: 5Y00559607224", dateLivraison: "2026-04-05" },
  { nom: "MOHAMED K",         instagram: "Boulangerie le111",            tiktok: "",               type: "cafe",      pays: "FR", produitRaw: "2 Pot laya 100g",                            fraisPortCsv: 7.59,  statut: "posté",  trackingNumber: "LP: 5Y00551831986", dateLivraison: "2026-03-05" },
];

async function main() {
  console.log("── Parsing et vérification ──────────────────────────────────");

  const data = RAW.map(r => {
    const comps   = parseUgcProduit(r.produitRaw);
    const produit = compsToKey(comps);
    const cp      = coutComps(comps);
    // Shipping : si valeur CSV dispo on la garde (données réelles) ; sinon on calcule
    const port    = r.fraisPortCsv !== null ? r.fraisPortCsv : ugcShipping(r.pays, comps);

    console.log(`  ${r.nom.padEnd(22)} "${r.produitRaw.padEnd(40)}" → ${produit.padEnd(18)} pots:${comps.pots} fouets:${comps.fouets} bols:${comps.bols} cuilleres:${comps.cuilleres}  port:${port.toFixed(2)}€`);

    return {
      nom:           r.nom,
      instagram:     r.instagram,
      tiktok:        r.tiktok,
      contact:       null,
      type:          r.type,
      plateforme:    "Réseaux sociaux",
      pays:          r.pays,
      produit,
      quantite:      1,
      statut:        r.statut,
      fraisPort:     port,
      trackingNumber:r.trackingNumber ?? null,
      codePromo:     r.codePromo ?? null,
      dateLivraison: r.dateLivraison ?? null,
      lienVideo:     null,
      coutProduit:   cp,
      coutTotalCollab: cp + port,
    };
  });

  console.log("\n── Insertion en base ────────────────────────────────────────");
  await prisma.creator.deleteMany();
  const result = await prisma.creator.createMany({ data });
  console.log(`✓ ${result.count} créateurs insérés`);

  const totals = data.reduce((acc, c) => ({
    cogs: acc.cogs + c.coutProduit,
    port: acc.port + c.fraisPort,
    total: acc.total + c.coutTotalCollab,
  }), { cogs: 0, port: 0, total: 0 });

  console.log(`\n  COGS produits UGC : ${totals.cogs.toFixed(2)} €`);
  console.log(`  Livraison UGC     : ${totals.port.toFixed(2)} €`);
  console.log(`  Total UGC         : ${totals.total.toFixed(2)} €`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
