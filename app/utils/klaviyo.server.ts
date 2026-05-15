import type { OrderEmailLog } from "@prisma/client";
import { validateEmailRecipient, markEmailError } from "./shipping-store";

const DRY_RUN = process.env.KLAVIYO_DRY_RUN !== "false";
const API_KEY = process.env.KLAVIYO_API_KEY ?? "";

export type EmailType = "confirmation" | "shipping";

export type TransactionalEmailPayload = {
  templateId: string;
  to: string;
  subject: string;
  properties: Record<string, unknown>;
};

function buildPayload(log: OrderEmailLog, type: EmailType): TransactionalEmailPayload {
  const base = {
    to: log.customerEmail,
    properties: {
      orderName: log.orderName,
      customerName: log.customerName,
      productsSummary: log.productsSummary,
    },
  };

  if (type === "confirmation") {
    return {
      ...base,
      templateId: process.env.KLAVIYO_TEMPLATE_CONFIRMATION ?? "TPL_CONFIRMATION",
      subject: `Confirmation de commande ${log.orderName}`,
    };
  }

  return {
    ...base,
    templateId: process.env.KLAVIYO_TEMPLATE_SHIPPING ?? "TPL_SHIPPING",
    subject: `Votre commande ${log.orderName} est en route`,
    properties: {
      ...base.properties,
      carrier: log.carrier,
      trackingNumber: log.trackingNumber,
      trackingUrl: log.trackingUrl,
    },
  };
}

export async function sendTransactionalEmail(
  log: OrderEmailLog,
  type: EmailType,
): Promise<{ sent: boolean; dry: boolean }> {
  const valid = await validateEmailRecipient(log);
  if (!valid) return { sent: false, dry: DRY_RUN };

  const payload = buildPayload(log, type);

  if (DRY_RUN) {
    console.log("⛔ DRY RUN ACTIVE — NO EMAIL SENT", {
      type,
      to: payload.to,
      subject: payload.subject,
      templateId: payload.templateId,
      properties: payload.properties,
    });
    return { sent: false, dry: true };
  }

  if (process.env.KLAVIYO_DRY_RUN !== "false") {
    console.error("⛔ DRY RUN ACTIVE — NO EMAIL SENT (safety lock)");
    return { sent: false, dry: true };
  }

  // Real send (reached only when KLAVIYO_DRY_RUN=false and API_KEY set)
  try {
    const resp = await fetch("https://a.klaviyo.com/api/send-email/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Klaviyo-API-Key ${API_KEY}`,
        revision: "2024-02-15",
      },
      body: JSON.stringify({
        data: {
          type: "send-email",
          attributes: {
            sending_options: { use_smart_sending: false },
            message: {
              channel: "email",
              to: [{ email: payload.to }],
              subject: payload.subject,
              content: { template_id: payload.templateId },
              context: payload.properties,
            },
          },
        },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Klaviyo ${resp.status}: ${body}`);
    }

    return { sent: true, dry: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markEmailError(log.id, message);
    throw err;
  }
}
