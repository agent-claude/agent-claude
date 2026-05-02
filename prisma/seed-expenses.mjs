// npx node --env-file=.env prisma/seed-expenses.mjs
// Injecte les charges initiales en base Expense (migration depuis hardcodé)
// Idempotent : skip si des dépenses existent déjà
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const EXPENSES = [
  { label: "Cartons d'expédition", category: "Packaging",    amount: 95,  type: "ponctuelle", note: null },
  { label: "Flyers",               category: "Packaging",    amount: 55,  type: "ponctuelle", note: null },
  { label: "Graphiste",            category: "Graphiste",    amount: 100, type: "ponctuelle", note: null },
  { label: "Shopify",              category: "Shopify",      amount: 66,  type: "mensuelle",  note: "33 €/mois × 2 (mars–avr.)" },
  { label: "Stickers",             category: "Packaging",    amount: 100, type: "ponctuelle", note: null },
  { label: "Événements",           category: "Événements",   amount: 300, type: "ponctuelle", note: "3 ventes" },
  { label: "Flyers pro",           category: "Packaging",    amount: 54,  type: "ponctuelle", note: null },
  // Note : "Livraison UGC & collabs" est calculée automatiquement
  // depuis Creator.fraisPort — ne pas l'ajouter ici (double-compte)
];

async function main() {
  const existing = await prisma.expense.count();
  if (existing > 0) {
    console.log(`[Seed] ${existing} dépense(s) déjà présente(s) — skip.`);
    return;
  }

  const date = new Date("2025-03-01T00:00:00.000Z");
  for (const e of EXPENSES) {
    await prisma.expense.create({ data: { date, ...e } });
    console.log(`[Seed] ✅ ${e.label.padEnd(30)} ${String(e.amount).padStart(6)} €`);
  }

  const total = EXPENSES.reduce((s, e) => s + e.amount, 0);
  console.log(`\n[Seed] ✅ ${EXPENSES.length} dépenses insérées — total ${total} €`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
