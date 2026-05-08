import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// POST /app/api/creator-statut
// Body: id + (shippingStatus | contentStatus)

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const form = await request.formData();

  const id = String(form.get("id") || "").trim();
  const shippingStatus = String(form.get("shippingStatus") || "").trim();
  const contentStatus = String(form.get("contentStatus") || "").trim();

  if (!id) {
    return Response.json({ error: "id requis" }, { status: 400 });
  }

  const data: Record<string, string> = {};

  if (shippingStatus) {
    data.shippingStatus = shippingStatus;

    // important : ton app utilise aussi "statut" dans plusieurs endroits
    data.statut = shippingStatus;

    if (shippingStatus === "livre") {
      data.dateLivraison = new Date().toISOString().slice(0, 10);
    }
  }

  if (contentStatus) {
    data.contentStatus = contentStatus;
  }

  if (Object.keys(data).length === 0) {
    return Response.json(
      { error: "shippingStatus ou contentStatus requis" },
      { status: 400 },
    );
  }

  const updated = await prisma.creator.update({
    where: { id },
    data,
  });

  return Response.json({ ok: true, id, ...data });
};