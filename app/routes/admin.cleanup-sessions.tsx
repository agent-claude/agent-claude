import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

const SECRET = "laya-cleanup-2026";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

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
