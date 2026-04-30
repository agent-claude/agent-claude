// Ajoute 3 nouveaux UGC SANS écraser les anciens
// npx node --env-file=.env prisma/seed-ugc-add-2.mjs
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const COUT = { pot: 3.77055, fouet: 4.1806, bol: 4.1806, cuillere: 2.40 };

function keyToComps(produit) {
  switch (produit) {
    case "pot":             return { pots: 1, fouets: 0, bols: 0, cuilleres: 0 };
    case "kit_decouverte":  return { pots: 1, fouets: 1, bols: 0, cuilleres: 0 };
    case "kit_ultime":      return { pots: 1, fouets: 1, bols: 1, cuilleres: 0 };
    default:                return { pots: 1, fouets: 0, bols: 0, cuilleres: 0 };
  }
}

function coutComps(c) {
  return c.pots * COUT.pot + c.fouets * COUT.fouet + c.bols * COUT.bol + c.cuilleres * COUT.cuillere;
}

function ugcShipping(pays, comps) {
  const isUltime = comps.bols > 0;
  switch (pays) {
    case "FR": return isUltime ? 9.29 : 5.49;
    case "BE": return isUltime ? 6.60 : 4.60;
    case "IT":
    case "PT": return isUltime ? 9.50 : 6.60;
    case "DE": return isUltime ? 13.80 : 12.50;
    case "CH": return isUltime ? 19.39 : 14.99;
    default:   return 0;
  }
}

// "1 pot + 1 fouet" → kit_decouverte (parser résultat)
const NOUVEAUX = [
  { nom: "Edwina Battaglia", pays: "BE", produit: "kit_ultime",   statut: "envoyé" },
  { nom: "Diana Beliakova",  pays: "IT", produit: "kit_ultime",   statut: "en_preparation", notes: "adresse en attente" },
  { nom: "Margaux Saddier",  pays: "FR", produit: "kit_decouverte", statut: "envoyé" },
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
        nom:             entry.nom,
        instagram:       "",
        tiktok:          "",
        type:            "ugc",
        plateforme:      "Réseaux sociaux",
        pays:            entry.pays,
        produit:         entry.produit,
        quantite:        1,
        statut:          entry.statut,
        fraisPort:       port,
        coutProduit:     cp,
        coutTotalCollab: cp + port,
        notes:           entry.notes ?? null,
      },
    });

    const compsStr = [
      comps.pots   ? `${comps.pots} pot${comps.pots > 1 ? "s" : ""}` : null,
      comps.fouets ? `${comps.fouets} fouet` : null,
      comps.bols   ? `${comps.bols} bol` : null,
    ].filter(Boolean).join(" + ");

    console.log(`  ADD   ${entry.nom.padEnd(28)} ${entry.produit.padEnd(15)} [${compsStr}]  cp:${cp.toFixed(2)}€  port:${port.toFixed(2)}€  statut:${entry.statut}`);
    inserted++;
  }

  console.log(`\n✓ ${inserted} ajouté(s), ${skipped} ignoré(s)`);

  // Récap global
  const all = await prisma.creator.findMany();
  const totaux = all.reduce((acc, c) => ({
    count: acc.count + 1,
    cogs:  acc.cogs  + (c.coutProduit ?? 0),
    port:  acc.port  + c.fraisPort,
    total: acc.total + (c.coutTotalCollab ?? 0),
  }), { count: 0, cogs: 0, port: 0, total: 0 });

  // Totaux composants
  const COUT_LOCAL = { pot: 3.77055, fouet: 4.1806, bol: 4.1806, cuillere: 2.40 };
  let pots = 0, fouets = 0, bols = 0, cuilleres = 0;
  for (const c of all) {
    const comps = keyToComps(c.produit);
    pots      += comps.pots      * (c.quantite ?? 1);
    fouets    += comps.fouets    * (c.quantite ?? 1);
    bols      += comps.bols      * (c.quantite ?? 1);
    cuilleres += comps.cuilleres * (c.quantite ?? 1);
  }

  console.log(`\n── Totaux DB après insertion ─────────────────────────────────`);
  console.log(`  Total créateurs : ${totaux.count}`);
  console.log(`  COGS produits   : ${totaux.cogs.toFixed(2)} €`);
  console.log(`  Livraison       : ${totaux.port.toFixed(2)} €`);
  console.log(`  Total UGC       : ${totaux.total.toFixed(2)} €`);
  console.log(`\n── Composants offerts ────────────────────────────────────────`);
  console.log(`  Pots      : ${pots}   (${(pots * COUT_LOCAL.pot).toFixed(2)} €)`);
  console.log(`  Fouets    : ${fouets}   (${(fouets * COUT_LOCAL.fouet).toFixed(2)} €)`);
  console.log(`  Bols      : ${bols}   (${(bols * COUT_LOCAL.bol).toFixed(2)} €)`);
  console.log(`  Cuillères : ${cuilleres}   (${(cuilleres * COUT_LOCAL.cuillere).toFixed(2)} €)`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
