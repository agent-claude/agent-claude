import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// POST /app/api/creator-statut
// Body: id + (shippingStatus | contentStatus)

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const id   = (form.get("id") as string)?.trim();

  if (!id) return Response.json({ error: "id requis" }, { status: 400 });

  const data: Record<string, string> = {};
  const shippingStatus = (form.get("shippingStatus") as string)?.trim();
  const contentStatus  = (form.get("contentStatus")  as string)?.trim();

  if (shippingStatus) data.shippingStatus = shippingStatus;
  if (contentStatus)  data.contentStatus  = contentStatus;

  if (Object.keys(data).length === 0) {
    return Response.json({ error: "shippingStatus ou contentStatus requis" }, { status: 400 });
  }

  await prisma.creator.update({ where: { id }, data });
  return Response.json({ ok: true, id, ...data });
};
