import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// POST /app/api/creator-statut
// Body: id + (shippingStatus | contentStatus)

const VALID_SHIPPING = new Set(["en_attente", "preparation", "envoye", "livre", "refuse"]);
const VALID_CONTENT  = new Set(["a_faire", "recu", "poste"]);

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const form = await request.formData();

  const id             = String(form.get("id")             || "").trim();
  const shippingStatus = String(form.get("shippingStatus") || "").trim();
  const contentStatus  = String(form.get("contentStatus")  || "").trim();

  console.log("UGC STATUS UPDATE", {
    id,
    shippingStatus: shippingStatus || undefined,
    contentStatus:  contentStatus  || undefined,
  });

  if (!id) {
    return Response.json({ error: "id requis" }, { status: 400 });
  }

  if (shippingStatus && !VALID_SHIPPING.has(shippingStatus)) {
    console.error("UGC STATUS UPDATE — valeur shippingStatus invalide:", shippingStatus);
    return Response.json({ error: `shippingStatus invalide: ${shippingStatus}` }, { status: 400 });
  }

  if (contentStatus && !VALID_CONTENT.has(contentStatus)) {
    console.error("UGC STATUS UPDATE — valeur contentStatus invalide:", contentStatus);
    return Response.json({ error: `contentStatus invalide: ${contentStatus}` }, { status: 400 });
  }

  const data: {
    shippingStatus?: string;
    statut?: string;
    contentStatus?: string;
    dateLivraison?: string;
  } = {};

  if (shippingStatus) {
    data.shippingStatus = shippingStatus;
    data.statut         = shippingStatus; // champ legacy synchronisé
    if (shippingStatus === "livre") {
      data.dateLivraison = new Date().toISOString().slice(0, 10);
    }
  }

  if (contentStatus) {
    data.contentStatus = contentStatus;
  }

  if (Object.keys(data).length === 0) {
    return Response.json({ error: "shippingStatus ou contentStatus requis" }, { status: 400 });
  }

  try {
    const updated = await prisma.creator.update({
      where: { id },
      data,
    });
    console.log("UGC STATUS UPDATED OK", { id: updated.id, data });
    return Response.json({ ok: true, id: updated.id, ...data });
  } catch (err) {
    console.error("UGC STATUS UPDATE ERROR", { id, data, err });
    return Response.json({ error: "update failed" }, { status: 500 });
  }
};