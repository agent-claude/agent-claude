// LAYA email templates — pure HTML strings, email-safe inline styles.
// No external dependencies. Render in iframe for preview, paste into Klaviyo later.

import { carrierLabel, displayCarrier, lastMilePartnerForCountry } from "../utils/tracking";

const COLORS = {
  cream: "#F7F2EC",
  creamLight: "#FBF8F4",
  ink: "#1A1015",
  aubergine: "#3E2552",
  violet: "#7A4DB3",
  lilas: "#EDE2EE",
  hairline: "#E5DAD8",
  muted: "#6B5F70",
};

const FONT = `-apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`;

export type EmailContext = {
  customerName: string;
  orderName: string;
  productsSummary: string;
  country?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstName(full: string): string {
  const trimmed = full.trim();
  if (!trimmed || trimmed === "—") return "";
  return trimmed.split(/\s+/)[0];
}

function productsList(summary: string): string {
  if (!summary) return "";
  const items = summary.split(",").map((s) => s.trim()).filter(Boolean);
  return items
    .map(
      (item) => `
      <tr>
        <td style="padding: 6px 0; font-size: 14px; color: ${COLORS.ink}; line-height: 1.55;">
          ${escapeHtml(item)}
        </td>
      </tr>`,
    )
    .join("");
}

function wrap(inner: string, preheader: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>LAYA</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${COLORS.cream}; font-family: ${FONT};">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; visibility:hidden; mso-hide:all;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${COLORS.cream}; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 560px;">
          <tr>
            <td style="padding: 24px 8px; text-align: center;">
              <div style="font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; color: ${COLORS.aubergine}; font-weight: 600;">
                LAYA
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color: ${COLORS.creamLight}; border: 1px solid ${COLORS.hairline}; border-radius: 14px; padding: 32px 28px;">
              ${inner}
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 8px; text-align: center; font-size: 11px; color: ${COLORS.muted}; line-height: 1.6;">
              LAYA — poudre d'ube des Philippines<br />
              ubelaya.com
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function confirmationSubject(ctx: EmailContext): string {
  return `Merci pour votre commande ${ctx.orderName} — LAYA`;
}

export function shippingSubject(ctx: EmailContext): string {
  return `Votre commande ${ctx.orderName} est en route`;
}

export function renderConfirmationEmail(ctx: EmailContext): string {
  const fn = firstName(ctx.customerName);
  const greeting = fn ? `Bonjour ${escapeHtml(fn)},` : "Bonjour,";
  const items = productsList(ctx.productsSummary);

  const inner = `
    <h1 style="margin: 0 0 16px; font-size: 22px; line-height: 1.2; color: ${COLORS.ink}; font-weight: 600; letter-spacing: -0.01em;">
      Votre commande est bien enregistrée.
    </h1>
    <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.65; color: ${COLORS.ink};">
      ${greeting}
    </p>
    <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.65; color: ${COLORS.ink};">
      Merci pour votre commande <strong>${escapeHtml(ctx.orderName)}</strong>. Nous la préparons avec soin et reviendrons vers vous dès qu'elle quitte notre atelier.
    </p>

    <div style="height: 1px; background-color: ${COLORS.hairline}; margin: 24px 0;"></div>

    <div style="font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${COLORS.muted}; font-weight: 600; margin-bottom: 10px;">
      Récapitulatif
    </div>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${items || `<tr><td style="font-size: 14px; color: ${COLORS.muted};">—</td></tr>`}
    </table>

    <div style="height: 1px; background-color: ${COLORS.hairline}; margin: 28px 0;"></div>

    <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.65; color: ${COLORS.ink};">
      Une question ? Répondez simplement à cet email, nous lisons chaque message.
    </p>
    <p style="margin: 20px 0 0; font-size: 14px; line-height: 1.65; color: ${COLORS.muted};">
      L'équipe LAYA
    </p>
  `;

  return wrap(inner, "Merci pour votre commande, nous la préparons.");
}

export function renderShippingEmail(ctx: EmailContext): string {
  const fn = firstName(ctx.customerName);
  const greeting = fn ? `Bonjour ${escapeHtml(fn)},` : "Bonjour,";
  const carrierBase = ctx.carrier ? carrierLabel(ctx.carrier) : null;
  const carrierDisplay = ctx.carrier ? displayCarrier(ctx.carrier, ctx.country) : null;
  const trackingNumber = ctx.trackingNumber?.trim();
  const trackingUrl = ctx.trackingUrl?.trim();
  const country = ctx.country?.trim() || null;
  const partner = lastMilePartnerForCountry(ctx.carrier, ctx.country);

  const trackingBlock = trackingUrl
    ? `
      <div style="margin: 24px 0;">
        <a href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener" style="display: inline-block; background-color: ${COLORS.aubergine}; color: ${COLORS.cream}; text-decoration: none; padding: 14px 28px; border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.04em;">
          Suivre mon colis
        </a>
      </div>
    `
    : "";

  const trackingDetails =
    carrierDisplay || trackingNumber || country
      ? `
      <div style="height: 1px; background-color: ${COLORS.hairline}; margin: 24px 0;"></div>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${
          carrierDisplay
            ? `<tr>
                <td style="padding: 4px 0; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${COLORS.muted}; font-weight: 600; width: 120px;">Transporteur</td>
                <td style="padding: 4px 0; font-size: 14px; color: ${COLORS.ink};">${escapeHtml(carrierDisplay)}</td>
              </tr>`
            : ""
        }
        ${
          trackingNumber
            ? `<tr>
                <td style="padding: 4px 0; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${COLORS.muted}; font-weight: 600; width: 120px;">N° de suivi</td>
                <td style="padding: 4px 0; font-size: 14px; color: ${COLORS.ink}; font-family: 'SF Mono', Menlo, Consolas, monospace;">${escapeHtml(trackingNumber)}</td>
              </tr>`
            : ""
        }
        ${
          country
            ? `<tr>
                <td style="padding: 4px 0; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${COLORS.muted}; font-weight: 600; width: 120px;">Destination</td>
                <td style="padding: 4px 0; font-size: 14px; color: ${COLORS.ink};">${escapeHtml(country)}</td>
              </tr>`
            : ""
        }
      </table>
    `
      : "";

  const partnerNote = partner
    ? `
    <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.65; color: ${COLORS.muted};">
      ${
        country
          ? `La livraison finale ${escapeHtml(`en ${country}`)} peut être prise en charge par notre partenaire local <strong style="color: ${COLORS.ink};">${escapeHtml(partner)}</strong>.`
          : `La livraison finale peut être prise en charge par notre partenaire local <strong style="color: ${COLORS.ink};">${escapeHtml(partner)}</strong>.`
      }
    </p>`
    : "";

  const inner = `
    <h1 style="margin: 0 0 16px; font-size: 22px; line-height: 1.2; color: ${COLORS.ink}; font-weight: 600; letter-spacing: -0.01em;">
      Votre commande est en route.
    </h1>
    <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.65; color: ${COLORS.ink};">
      ${greeting}
    </p>
    <p style="margin: 0 0 0; font-size: 15px; line-height: 1.65; color: ${COLORS.ink};">
      Bonne nouvelle — votre commande <strong>${escapeHtml(ctx.orderName)}</strong> vient de quitter notre atelier${carrierBase ? ` et a été confiée à ${escapeHtml(carrierBase)}` : ""}.
    </p>
    ${partnerNote}

    ${trackingBlock}
    ${trackingDetails}

    <div style="height: 1px; background-color: ${COLORS.hairline}; margin: 28px 0;"></div>

    <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.65; color: ${COLORS.ink};">
      À très vite,
    </p>
    <p style="margin: 0; font-size: 14px; line-height: 1.65; color: ${COLORS.muted};">
      L'équipe LAYA
    </p>
  `;

  return wrap(inner, "Votre commande LAYA vient de partir.");
}

export type EmailType = "confirmation" | "shipping";

export function renderEmail(type: EmailType, ctx: EmailContext): { subject: string; html: string } {
  if (type === "confirmation") {
    return { subject: confirmationSubject(ctx), html: renderConfirmationEmail(ctx) };
  }
  return { subject: shippingSubject(ctx), html: renderShippingEmail(ctx) };
}
