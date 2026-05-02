// Run from Render Shell: node scripts/cleanup-sessions.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const all = await prisma.session.findMany({
    select: { id: true, shop: true, scope: true, expires: true },
  });

  console.log("Sessions actuelles :");
  for (const s of all) {
    console.log(`  ${s.id} | shop=${s.shop} | expires=${s.expires ?? "jamais"}`);
  }

  const TARGET_SHOP = "laya-9606.myshopify.com";

  const toDelete = all
    .filter((s) => s.shop !== TARGET_SHOP)
    .map((s) => s.id);

  if (toDelete.length === 0) {
    console.log("\nAucune session à supprimer.");
    return;
  }

  const { count } = await prisma.session.deleteMany({
    where: { id: { in: toDelete } },
  });

  console.log(`\nSupprimé ${count} session(s) hors ${TARGET_SHOP} :`, toDelete);

  const remaining = await prisma.session.findMany({
    select: { id: true, shop: true },
  });
  console.log("Sessions restantes :", remaining.map((s) => s.shop));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
