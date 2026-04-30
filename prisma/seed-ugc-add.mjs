// Ajoute les nouveaux UGC SANS écraser les anciens
// npx node --env-file=.env prisma/seed-ugc-add.mjs
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COUT = { pot: 3.77055, fouet: 4.1806, bol: 4.1806, cuillere: 2.40 };

function keyToComps(produit) {
  switch (produit) {
    case "pot":            return { pots: 1, fouets: 0, bols: 0, cuilleres: 0 };
    case "2_pots":         return { pots: 2, fouets: 0, bols: 0, cuilleres: 0 };
    case "kit_decouverte": return { pots: 1, fouets: 1, bols: 0, cuilleres: 0 };
    case "kit_ultime":     return { pots: 1, fouets: 1, bols: 1, cuilleres: 0 };
    default:               return { pots: 1, fouets: 0, bols: 0, cuilleres: 0 };
  }
}

function coutComps(c) {
  return c.pots * COUT.pot + c.fouets * COUT.fouet + c.bols * COUT.bol + c.cuilleres * COUT.cuillere;
}

function ugcShipping(pays, comps) {
  const isUltime = comps.bols > 0;
  const is3pots  = comps.pots >= 3 && !isUltime;
  switch (pays) {
    case "FR": return isUltime ? 9.29 : is3pots ? 7.59 : 5.49;
    case "BE": return isUltime ? 6.60 : 4.60;
    case "IT":
    case "PT": return isUltime ? 9.50 : 6.60;
    case "DE": return isUltime ? 13.80 : 12.50;
    case "CH": return isUltime ? 19.39 : 14.99;
    default:   return 0;
  }
}

// Nouveaux UGC à ajouter
const NOUVEAUX = [
  { nom: "Abir Mustafa",            pays: "DE", produit: "pot",           statut: "envoyé",         notes: "vidéos tiramisu" },
  { nom: "Annie Pichon",            pays: "FR", produit: "pot",           statut: "en_preparation",  notes: "concours fête des mères — ok en attente sirop" },
  { nom: "Tetard Leelou",           pays: "FR", produit: "kit_ultime",    statut: "envoyé",         notes: "2 vidéos" },
  { nom: "Dalia Palmieri",          pays: "FR", produit: "kit_ultime",    statut: "envoyé" },
  { nom: "Dounia",                  pays: "FR", produit: "kit_ultime",    statut: "envoyé" },
  { nom: "Yasmine SINGH",           pays: "FR", produit: "kit_ultime",    statut: "envoyé" },
  { nom: "Orane Bezert",            pays: "FR", produit: "kit_ultime",    statut: "envoyé" },
  { nom: "Sirine Yahia",            pays: "FR", produit: "pot",           statut: "envoyé" },
  { nom: "Yvette Delort Rodrigues", pays: "FR", produit: "pot",           statut: "envoyé" },
  { nom: "Salma",                   pays: "FR", produit: "pot",           statut: "envoyé" },
  { nom: "Alice Kang",              pays: "DE", produit: "kit_decouverte",statut: "envoyé",         notes: "contrat à faire en anglais" },
];

async function main() {
  console.log("── Vérification doublons ─────────────────────────────────────");

  let inserted = 0;
  let skipped  = 0;

  for (const entry of NOUVEAUX) {
    const exists = await prisma.creator.findFirst({ where: { nom: entry.nom } });
    if (exists) {
      console.log(`  SKIP  ${entry.nom} (déjà présent)`);
      skipped++;
      continue;
    }

    const comps = keyToComps(entry.produit);
    const cp    = coutComps(comps);
    const port  = ugcShipping(entry.pays, comps);

    await prisma.creator.create({
      data: {
        nom:            entry.nom,
        instagram:      "",
        tiktok:         "",
        type:           "ugc",
        plateforme:     "Réseaux sociaux",
        pays:           entry.pays,
        produit:        entry.produit,
        quantite:       1,
        statut:         entry.statut,
        fraisPort:      port,
        coutProduit:    cp,
        coutTotalCollab: cp + port,
        notes:          entry.notes ?? null,
      },
    });

    const compsStr = [
      comps.pots      ? `${comps.pots} pot${comps.pots > 1 ? "s" : ""}` : null,
      comps.fouets    ? `${comps.fouets} fouet` : null,
      comps.bols      ? `${comps.bols} bol` : null,
      comps.cuilleres ? `${comps.cuilleres} cuillère` : null,
    ].filter(Boolean).join(" + ");

    console.log(`  ADD   ${entry.nom.padEnd(28)} ${entry.produit.padEnd(15)} [${compsStr}]  cp:${cp.toFixed(2)}€  port:${port.toFixed(2)}€  statut:${entry.statut}`);
    inserted++;
  }

  console.log(`\n✓ ${inserted} ajouté(s), ${skipped} ignoré(s)`);

  // Récap global
  const all = await prisma.creator.findMany();
  const totaux = all.reduce((acc, c) => ({
    count:   acc.count + 1,
    cogs:    acc.cogs  + (c.coutProduit ?? 0),
    port:    acc.port  + c.fraisPort,
    total:   acc.total + (c.coutTotalCollab ?? 0),
  }), { count: 0, cogs: 0, port: 0, total: 0 });

  console.log(`\n── Totaux DB après insertion ─────────────────────────────────`);
  console.log(`  Total créateurs : ${totaux.count}`);
  console.log(`  COGS produits   : ${totaux.cogs.toFixed(2)} €`);
  console.log(`  Livraison       : ${totaux.port.toFixed(2)} €`);
  console.log(`  Total UGC       : ${totaux.total.toFixed(2)} €`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
