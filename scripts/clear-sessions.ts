import prisma from "../app/db.server";

async function clearSessions() {
  const before = await prisma.session.count();
  console.log(`Sessions en base avant nettoyage : ${before}`);

  const shops = await prisma.session.findMany({ select: { shop: true, id: true } });
  for (const s of shops) {
    console.log(`  - ${s.id} → ${s.shop}`);
  }

  await prisma.session.deleteMany({});
  console.log(`Sessions supprimées. Réinstalle l'app sur laya-9606.myshopify.com.`);
}

clearSessions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
