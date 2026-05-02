import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

const SECRET = "laya-cleanup-2026";

const SEED_EXPENSES = [
  { label: "Cartons d'expédition", category: "Packaging",  amount: 95,  type: "ponctuelle", note: null },
  { label: "Flyers",               category: "Packaging",  amount: 55,  type: "ponctuelle", note: null },
  { label: "Graphiste",            category: "Graphiste",  amount: 100, type: "ponctuelle", note: null },
  { label: "Shopify",              category: "Shopify",    amount: 66,  type: "mensuelle",  note: "33 €/mois × 2 (mars–avr.)" },
  { label: "Stickers",             category: "Packaging",  amount: 100, type: "ponctuelle", note: null },
  { label: "Événements",           category: "Événements", amount: 450, type: "ponctuelle", note: "3 ventes" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const action = url.searchParams.get("action") ?? "cleanup";

  // ── Seed expenses ──────────────────────────────────────────────────────────
  if (action === "seed-expenses") {
    const existing = await prisma.expense.count();
    if (existing > 0) {
      const all = await prisma.expense.findMany({ select: { label: true, amount: true } });
      return Response.json({ status: "already_seeded", count: existing, expenses: all });
    }
    const date = new Date("2025-03-01T00:00:00.000Z");
    await prisma.expense.createMany({
      data: SEED_EXPENSES.map((e) => ({ date, ...e })),
    });
    const total = SEED_EXPENSES.reduce((s, e) => s + e.amount, 0);
    return Response.json({ status: "seeded", count: SEED_EXPENSES.length, total, expenses: SEED_EXPENSES });
  }

  // ── Cleanup sessions ───────────────────────────────────────────────────────
  const all = await prisma.session.findMany({
    select: { id: true, shop: true, scope: true },
  });

  const toDelete = all
    .filter((s) => s.shop !== "laya-9606.myshopify.com")
    .map((s) => s.id);

  let deleted = 0;
  if (toDelete.length > 0) {
    const result = await prisma.session.deleteMany({
      where: { id: { in: toDelete } },
    });
    deleted = result.count;
  }

  const remaining = await prisma.session.findMany({
    select: { id: true, shop: true, scope: true },
  });

  return Response.json({
    avant: all.map((s) => ({ shop: s.shop, id: s.id })),
    supprimées: toDelete,
    deleted,
    restantes: remaining.map((s) => ({ shop: s.shop, id: s.id })),
  });
};
