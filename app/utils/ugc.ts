export type Country = "France" | "Allemagne" | "Suisse";
export type ProductType =
  | "1_pot"
  | "2_pots"
  | "3_pots"
  | "kit_decouverte"
  | "kit_ultime";
export type Status = "envoye" | "recu" | "poste" | "relance" | "abandonne";

export const COUNTRIES: Country[] = ["France", "Allemagne", "Suisse"];
export const PRODUCT_TYPES: { value: ProductType; label: string }[] = [
  { value: "1_pot", label: "1 pot" },
  { value: "2_pots", label: "2 pots" },
  { value: "3_pots", label: "3 pots" },
  { value: "kit_decouverte", label: "Kit Découverte" },
  { value: "kit_ultime", label: "Kit Ultime" },
];
export const STATUSES: { value: Status; label: string }[] = [
  { value: "envoye", label: "Envoyé" },
  { value: "recu", label: "Reçu" },
  { value: "poste", label: "Posté" },
  { value: "relance", label: "Relancé" },
  { value: "abandonne", label: "Abandonné" },
];

export function calcShipping(country: Country, product: ProductType): number {
  if (country === "France") {
    if (product === "3_pots") return 7.59;
    if (product === "kit_ultime") return 9.29;
    return 5.49;
  }
  if (country === "Allemagne") {
    if (product === "kit_ultime") return 13.8;
    return 12.5;
  }
  // Suisse
  if (product === "kit_ultime") return 19.39;
  return 14.99;
}

export function formatEur(amount: number): string {
  return amount.toFixed(2).replace(".", ",") + " €";
}

export function productLabel(value: string): string {
  return PRODUCT_TYPES.find((p) => p.value === value)?.label ?? value;
}

export function statusLabel(value: string): string {
  return STATUSES.find((s) => s.value === value)?.label ?? value;
}
