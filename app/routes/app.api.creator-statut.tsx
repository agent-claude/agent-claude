import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Route API dédiée : POST /app/api/creator-statut
// Body: id (String) + statut (String)

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form   = await request.formData();
  const id     = (form.get("id") as string)?.trim();
  const statut = (form.get("statut") as string)?.trim();

  if (!id || !statut) {
    return Response.json({ error: "id et statut requis" }, { status: 400 });
  }

  await prisma.creator.update({ where: { id }, data: { statut } });
  return Response.json({ ok: true, id, statut });
};
