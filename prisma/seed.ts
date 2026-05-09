import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const INITIAL_STOCK = [
  { composant: "pot",      quantite: 200, prixUnitaire: 3.77055 },
  { composant: "bol",      quantite: 50,  prixUnitaire: 4.1806  },
  { composant: "cuillere", quantite: 100, prixUnitaire: 2.40    },
  { composant: "fouet",    quantite: 100, prixUnitaire: 4.1806  },
] as const;

async function main() {
  const existing = await prisma.stockAchat.count();
  if (existing > 0) {
    console.log(`StockAchat already has ${existing} records — skipping seed.`);
    return;
  }
  for (const s of INITIAL_STOCK) {
    await prisma.stockAchat.create({
      data: {
        composant:    s.composant,
        quantite:     s.quantite,
        prixUnitaire: s.prixUnitaire,
        coutTotal:    s.quantite * s.prixUnitaire,
        date:         "2026-01-01",
        fournisseur:  "Stock initial",
        notes:        "Stock initial au démarrage",
      },
    });
    console.log(`  ✓ ${s.composant}: ${s.quantite} unités @ ${s.prixUnitaire}€ = ${(s.quantite * s.prixUnitaire).toFixed(2)}€`);
  }
  console.log("Seed terminé.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
