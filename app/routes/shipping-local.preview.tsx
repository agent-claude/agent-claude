import type { LoaderFunctionArgs } from "react-router";
import { getOrderEmailLog } from "../utils/shipping-store";
import { renderEmail, type EmailType } from "../emails/render";

// Standalone preview route, no Shopify auth, for /shipping-local iframe previews.

function isEmailType(value: string): value is EmailType {
  return value === "confirmation" || value === "shipping";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const logId = url.searchParams.get("logId");
  const typeParam = url.searchParams.get("type") ?? "confirmation";

  if (!logId) {
    return new Response("logId requis", { status: 400 });
  }
  if (!isEmailType(typeParam)) {
    return new Response("type invalide (confirmation|shipping)", { status: 400 });
  }

  const log = await getOrderEmailLog(logId);
  if (!log) {
    return new Response("Commande introuvable", { status: 404 });
  }

  const { html } = renderEmail(typeParam, {
    customerName: log.customerName,
    orderName: log.orderName,
    productsSummary: log.productsSummary,
    country: log.country,
    carrier: log.carrier,
    trackingNumber: log.trackingNumber,
    trackingUrl: log.trackingUrl,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
