export type Carrier =
  | "mondial_relay"
  | "colissimo"
  | "hermes_de"
  | "correos_es"
  | "ctt_pt";

export const CARRIERS: Carrier[] = [
  "mondial_relay",
  "colissimo",
  "hermes_de",
  "correos_es",
  "ctt_pt",
];

export const CARRIER_LABELS: Record<Carrier, string> = {
  mondial_relay: "Mondial Relay",
  colissimo: "Colissimo",
  hermes_de: "Hermes Allemagne",
  correos_es: "Correos España",
  ctt_pt: "CTT Portugal",
};

export function isCarrier(value: unknown): value is Carrier {
  return typeof value === "string" && (CARRIERS as string[]).includes(value);
}

export function carrierLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return isCarrier(value) ? CARRIER_LABELS[value] : value;
}

export function buildTrackingUrl(
  carrier: Carrier,
  trackingNumber: string,
  options?: { postalCode?: string | null },
): string {
  const t = trackingNumber.trim();
  if (!t) return "";
  switch (carrier) {
    case "mondial_relay": {
      const params = new URLSearchParams({ numeroExpedition: t });
      const cp = options?.postalCode?.trim();
      if (cp) params.set("codePostal", cp);
      return `https://www.mondialrelay.fr/suivi-de-colis/?${params.toString()}`;
    }
    case "colissimo":
      return `https://www.laposte.fr/outils/suivre-vos-envois?code=${encodeURIComponent(t)}`;
    case "hermes_de":
      return `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation/#${encodeURIComponent(t)}`;
    case "correos_es":
      return `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${encodeURIComponent(t)}`;
    case "ctt_pt":
      return `https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=${encodeURIComponent(t)}`;
  }
}

// Try to infer carrier from a free-text label coming from Shopify fulfillments.
export function inferCarrierFromLabel(label: string | null | undefined): Carrier | null {
  if (!label) return null;
  const lower = label.toLowerCase();
  if (lower.includes("mondial")) return "mondial_relay";
  if (lower.includes("colissimo") || lower.includes("la poste") || lower.includes("laposte")) return "colissimo";
  if (lower.includes("hermes")) return "hermes_de";
  if (lower.includes("correos")) return "correos_es";
  if (lower.includes("ctt")) return "ctt_pt";
  return null;
}

// Returns the carrier we suggest by default for a destination country.
// Booking carrier is Mondial Relay for BE/DE/ES/PT/IT (with last-mile partners),
// Colissimo for FR/CH. Used as a hint in the modal when no carrier is saved.
export function defaultCarrierForCountry(country: string | null | undefined): Carrier | null {
  if (!country) return null;
  const c = country.trim().toLowerCase();
  if (c === "france" || c === "fr") return "colissimo";
  if (c === "belgique" || c === "belgium" || c === "be") return "mondial_relay";
  if (c === "allemagne" || c === "germany" || c === "deutschland" || c === "de") return "mondial_relay";
  if (c === "suisse" || c === "switzerland" || c === "schweiz" || c === "ch") return "colissimo";
  if (c === "espagne" || c === "spain" || c === "españa" || c === "es") return "mondial_relay";
  if (c === "portugal" || c === "pt") return "mondial_relay";
  if (c === "italie" || c === "italy" || c === "italia" || c === "it") return "mondial_relay";
  return null;
}

// Last-mile partner that takes over for international Mondial Relay shipments.
// The tracking URL still goes to Mondial Relay; the partner is shown for clarity.
export function lastMilePartnerForCountry(
  carrier: string | null | undefined,
  country: string | null | undefined,
): string | null {
  if (carrier !== "mondial_relay" || !country) return null;
  const c = country.trim().toLowerCase();
  if (c === "allemagne" || c === "germany" || c === "deutschland" || c === "de") return "Hermes";
  if (c === "espagne" || c === "spain" || c === "españa" || c === "es") return "InPost";
  if (c === "portugal" || c === "pt") return "InPost";
  if (c === "italie" || c === "italy" || c === "italia" || c === "it") return "InPost";
  return null;
}

// Display label, with " → Partner" suffix when relevant (e.g. "Mondial Relay → InPost").
export function displayCarrier(
  carrier: string | null | undefined,
  country: string | null | undefined,
): string {
  const base = carrierLabel(carrier);
  const partner = lastMilePartnerForCountry(carrier, country);
  return partner ? `${base} → ${partner}` : base;
}
