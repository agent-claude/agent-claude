// Shared UGC utilities: parser, shipping, cost calculation

export interface Comps {
  pots: number;
  fouets: number;
  bols: number;
  cuilleres: number;
}

export const ZERO: Comps = { pots: 0, fouets: 0, bols: 0, cuilleres: 0 };

const COUT = { pot: 3.77055, fouet: 4.1806, bol: 4.1806, cuillere: 2.40 } as const;

// ─── Normalisation texte ──────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[''`]/g, "")           // apostrophes
    .trim();
}

// ─── Parser principal ─────────────────────────────────────────────────────────

/**
 * Convertit un texte libre (colonne "kit ou produits envoyés") en composants.
 * Exemples :
 *   "poudre, spoon"                             → {pots:1, cuilleres:1}
 *   "pot laya 100g + cuillère"                  → {pots:1, cuilleres:1}
 *   "pot laya 100g + cuillère + fouet"          → {pots:1, cuilleres:1, fouets:1}
 *   "2 pot laya 100g"                           → {pots:2}
 *   "kit complet"                               → {pots:1, fouets:1, bols:1}
 *   "kit ultime"                                → {pots:1, fouets:1, bols:1}
 *   "kit decouverte"                            → {pots:1, fouets:1}
 *   "kit complet + sirop vanille + lapin..."    → {pots:1, fouets:1, bols:1} (extras ignorés)
 */
export function parseUgcProduit(text: string): Comps {
  const t = norm(text);

  // ── Kit ultime / complet (most specific — toujours en premier) ───────────────
  if (
    t.includes("kit ultime") ||
    t.includes("kit complet") ||
    t.includes("kit ultimate") ||
    t.includes("full set") ||
    t.includes("set complet") ||
    // "set" seul (Dounia "set") — éviter de matcher "fouet" ou "reset"
    /(?:^|[\s,+])set(?:[\s,+]|$)/.test(t)
  ) {
    return { pots: 1, fouets: 1, bols: 1, cuilleres: 0 };
  }

  // ── Kit découverte ────────────────────────────────────────────────────────────
  if (t.includes("kit decouverte") || t.includes("kit découverte")) {
    return { pots: 1, fouets: 1, bols: 0, cuilleres: 0 };
  }

  // ── Parsing composant par composant ──────────────────────────────────────────
  let pots      = 0;
  let fouets    = 0;
  let bols      = 0;
  let cuilleres = 0;

  // Quantité de pots : "2 pot", "3 pots", "2 ube", etc.
  const qtyPot = t.match(/(\d+)\s*(?:x\s*)?(?:pot|pots|poudre|laya|ube)/);
  if (qtyPot) {
    pots = parseInt(qtyPot[1], 10);
  } else if (
    t.includes("pot") ||
    t.includes("poudre") ||
    t.includes("laya") ||
    t.includes("ube") ||       // UBE = matcha pot
    t.includes("un pot")       // "un pot" en français
  ) {
    pots = 1;
  }

  // Cuillère
  if (
    t.includes("cuillere") ||
    t.includes("cuilliere") ||
    t.includes("spoon") ||
    t.includes("cuiller")
  ) {
    cuilleres = 1;
  }

  // Fouet
  if (t.includes("fouet")) fouets = 1;

  // Bol
  if (t.includes("bol")) bols = 1;

  // ── Fallback : texte non reconnu → 1 pot par défaut ──────────────────────────
  if (pots === 0 && fouets === 0 && bols === 0 && cuilleres === 0) {
    pots = 1;
  }

  return { pots, fouets, bols, cuilleres };
}

// ─── Comps → clé normalisée ───────────────────────────────────────────────────

export function compsToKey(c: Comps): string {
  if (c.bols > 0 && c.fouets > 0 && c.pots > 0)              return "kit_ultime";
  if (c.fouets > 0 && c.pots > 0 && !c.bols && !c.cuilleres) return "kit_decouverte";
  if (c.pots > 0 && c.fouets > 0 && c.cuilleres > 0)         return "pot_fouet_cuillere";
  if (c.pots > 0 && c.cuilleres > 0)                         return "pot_cuillere";
  if (c.pots >= 3)                                           return "3_pots";
  if (c.pots >= 2)                                           return "2_pots";
  if (c.pots === 1)                                          return "pot";
  if (c.fouets > 0)                                          return "fouet";
  if (c.bols > 0)                                            return "bol";
  if (c.cuilleres > 0)                                       return "cuillere";
  return "pot";
}

// ─── Clé normalisée → Comps ───────────────────────────────────────────────────

export function keyToComps(produit: string, qty = 1): Comps {
  switch (produit) {
    case "pot":               return { pots: qty,     fouets: 0,   bols: 0,   cuilleres: 0   };
    case "2_pots":            return { pots: 2 * qty, fouets: 0,   bols: 0,   cuilleres: 0   };
    case "3_pots":            return { pots: 3 * qty, fouets: 0,   bols: 0,   cuilleres: 0   };
    case "kit_decouverte":    return { pots: qty,     fouets: qty, bols: 0,   cuilleres: 0   };
    case "kit_ultime":        return { pots: qty,     fouets: qty, bols: qty, cuilleres: 0   };
    case "pot_cuillere":      return { pots: qty,     fouets: 0,   bols: 0,   cuilleres: qty };
    case "pot_fouet_cuillere":return { pots: qty,     fouets: qty, bols: 0,   cuilleres: qty };
    case "fouet":             return { pots: 0,       fouets: qty, bols: 0,   cuilleres: 0   };
    case "bol":               return { pots: 0,       fouets: 0,   bols: qty, cuilleres: 0   };
    case "cuillere":          return { pots: 0,       fouets: 0,   bols: 0,   cuilleres: qty };
    default:                  return ZERO;
  }
}

// ─── Coût produit ─────────────────────────────────────────────────────────────

export function coutComps(c: Comps): number {
  return c.pots * COUT.pot + c.fouets * COUT.fouet + c.bols * COUT.bol + c.cuilleres * COUT.cuillere;
}

export function coutFromKey(produit: string, qty = 1): number {
  return coutComps(keyToComps(produit, qty));
}

// ─── Livraison UGC par pays (basée sur les Comps) ─────────────────────────────

export function ugcShippingCost(pays: string, comps: Comps): number {
  const isUltime = comps.bols > 0;          // bol = boîte kit ultime
  const is3pots  = comps.pots >= 3 && !isUltime;
  switch (pays.toUpperCase()) {
    case "FR": return isUltime ? 9.29 : is3pots ? 7.59 : 5.49;
    case "BE": return isUltime ? 6.60 : 4.60;
    case "IT":
    case "PT": return isUltime ? 9.50 : 6.60;
    case "DE": return isUltime ? 13.80 : 12.50;
    case "CH": return isUltime ? 19.39 : 14.99;
    default:   return 0;
  }
}

// Surcharge depuis la clé produit (pour le formulaire)
export function ugcShippingFromKey(pays: string, produit: string, qty = 1): number {
  return ugcShippingCost(pays, keyToComps(produit, qty));
}

// Surcharge depuis texte libre (pour import CSV)
export function ugcShippingFromText(pays: string, text: string): number {
  return ugcShippingCost(pays, parseUgcProduit(text));
}

// ─── Labels UI ────────────────────────────────────────────────────────────────

export const PRODUIT_LABELS: Record<string, string> = {
  pot:               "1 Pot",
  "2_pots":          "2 Pots",
  "3_pots":          "3 Pots",
  kit_decouverte:    "Kit Découverte (pot + fouet)",
  kit_ultime:        "Kit Ultime (pot + fouet + bol)",
  pot_cuillere:      "Pot + Cuillère",
  pot_fouet_cuillere:"Pot + Fouet + Cuillère",
};

export const TYPE_LABELS: Record<string, string> = {
  ugc:        "UGC",
  influence:  "Influence",
  cafe:       "Café / Demo",
  cafe_test:  "Café / Test",
  autre:      "Autre",
};

export const PAYS_LABELS: Record<string, string> = {
  FR: "France",
  BE: "Belgique",
  IT: "Italie",
  PT: "Portugal",
  DE: "Allemagne",
  CH: "Suisse",
};

// ─── Statuts UGC ─────────────────────────────────────────────────────────────

export const STATUTS = ["preparation", "envoye", "poste", "recu", "publie", "en_attente"] as const;
export type StatutUGC = typeof STATUTS[number];

export const STATUT_LABELS: Record<string, string> = {
  preparation:    "En préparation",
  envoye:         "Envoyé",
  poste:          "Posté",
  recu:           "Reçu",
  publie:         "Publié",
  en_attente:     "En attente",
  // Legacy (accents)
  en_preparation: "En préparation",
  "envoyé":       "Envoyé",
  "posté":        "Posté",
  "reçu":         "Reçu",
  "publié":       "Publié",
};

export const STATUT_COLORS: Record<string, { color: string; bg: string }> = {
  preparation:    { color: "#b45309", bg: "#fffbeb" },
  en_preparation: { color: "#b45309", bg: "#fffbeb" },
  envoye:         { color: "#1d4ed8", bg: "#eff6ff" },
  "envoyé":       { color: "#1d4ed8", bg: "#eff6ff" },
  poste:          { color: "#7c3aed", bg: "#f5f3ff" },
  "posté":        { color: "#7c3aed", bg: "#f5f3ff" },
  recu:           { color: "#0e7490", bg: "#ecfeff" },
  "reçu":         { color: "#0e7490", bg: "#ecfeff" },
  publie:         { color: "#047857", bg: "#ecfdf5" },
  "publié":       { color: "#047857", bg: "#ecfdf5" },
  en_attente:     { color: "#6b7280", bg: "#f9fafb" },
};

export function statutStyle(statut: string): { color: string; background: string } {
  const c = STATUT_COLORS[statut] ?? { color: "#6b7280", bg: "#f9fafb" };
  return { color: c.color, background: c.bg };
}

export function normStatut(raw: string): string {
  const r = (raw ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  if (r === "preparation" || r === "en_preparation") return "preparation";
  if (r.includes("publi"))                           return "publie";
  if (r.includes("post"))                            return "poste";
  if (r.includes("recu") || r.includes("livr"))     return "recu";
  if (r.includes("envoy"))                           return "envoye";
  if (r.includes("attente"))                         return "en_attente";
  if ((STATUTS as readonly string[]).includes(r))    return r;
  return "preparation";
}

// ─── Formatage ────────────────────────────────────────────────────────────────

export function eur(n: number): string {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

export function fmtComps(c: Comps): string {
  const p: string[] = [];
  if (c.pots > 0)      p.push(`${c.pots} pot${c.pots > 1 ? "s" : ""}`);
  if (c.fouets > 0)    p.push(`${c.fouets} fouet${c.fouets > 1 ? "s" : ""}`);
  if (c.bols > 0)      p.push(`${c.bols} bol${c.bols > 1 ? "s" : ""}`);
  if (c.cuilleres > 0) p.push(`${c.cuilleres} cuillère${c.cuilleres > 1 ? "s" : ""}`);
  return p.join(" + ") || "—";
}
