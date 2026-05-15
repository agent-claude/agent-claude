import { useMemo, useState } from "react";
import type { ActionFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  listOrderEmailLogs,
  upsertOrderEmailLog,
  saveTracking,
  markConfirmationReady,
  markShippingReady,
  resetEmailStatus,
  updateNotes,
  ShippingReadyError,
} from "../utils/shipping-store";
import { getDemoSnapshots, isDemoOrderId } from "../utils/demo-shipping";
import {
  CARRIERS,
  CARRIER_LABELS,
  defaultCarrierForCountry,
  displayCarrier,
} from "../utils/tracking";
import type { OrderEmailLog } from "@prisma/client";

// Standalone local mode for testing the shipping module without Shopify CLI.
// No Shopify auth, always demo data, no real emails sent.

const T = {
  bg: "#FBF8F4",
  card: "#FFFFFF",
  cardSoft: "#F8F2EA",
  rowHover: "#FAF4EB",
  border: "#E8DFD3",
  borderSoft: "#EFE7DA",
  text: "#1F1424",
  muted: "#6B5D6E",
  dim: "#A89DA8",

  aubergine: "#4A2557",
  aubergineDeep: "#3D1F47",
  aubergineSoft: "#F1E9F2",
  aubergineBorder: "#D9C5DE",
  aubergineHover: "#5C2E6D",

  green: "#3F7560",
  greenBg: "#ECF4EE",
  greenBorder: "#C8DDD0",

  amber: "#9B6A1F",
  amberBg: "#FAEFDE",
  amberBorder: "#E9D5AC",

  red: "#9B3838",
  redBg: "#F5E5E5",
  redBorder: "#E1BFBF",

  neutral: "#6B5D6E",
  neutralBg: "#F2EDE5",
  neutralBorder: "#E0D6C6",

  shadow: "0 1px 2px rgba(31,20,36,0.04), 0 2px 4px rgba(31,20,36,0.05)",
  shadowLg: "0 18px 48px rgba(31,20,36,0.20), 0 4px 12px rgba(31,20,36,0.08)",
};

// Keys cover French + English + native names + ISO 3166-1 alpha-2 codes.
// Shopify's `shippingAddress.country` is locale-dependent (FR/EN/native), and
// `countryCodeV2` is the 2-letter fallback. flagFor() normalizes both.
const FLAGS: Record<string, string> = {
  // France
  France: "🇫🇷", FR: "🇫🇷",
  // Belgique
  Belgique: "🇧🇪", Belgium: "🇧🇪", "België": "🇧🇪", BE: "🇧🇪",
  // Allemagne
  Allemagne: "🇩🇪", Germany: "🇩🇪", Deutschland: "🇩🇪", DE: "🇩🇪",
  // Suisse
  Suisse: "🇨🇭", Switzerland: "🇨🇭", Schweiz: "🇨🇭", Svizzera: "🇨🇭", CH: "🇨🇭",
  // Espagne
  Espagne: "🇪🇸", Spain: "🇪🇸", "España": "🇪🇸", ES: "🇪🇸",
  // Portugal
  Portugal: "🇵🇹", PT: "🇵🇹",
  // Italie
  Italie: "🇮🇹", Italy: "🇮🇹", Italia: "🇮🇹", IT: "🇮🇹",
  // Bonus EU
  "Pays-Bas": "🇳🇱", Netherlands: "🇳🇱", Nederland: "🇳🇱", NL: "🇳🇱",
  Luxembourg: "🇱🇺", LU: "🇱🇺",
  Autriche: "🇦🇹", Austria: "🇦🇹", "Österreich": "🇦🇹", AT: "🇦🇹",
  Irlande: "🇮🇪", Ireland: "🇮🇪", IE: "🇮🇪",
  "Royaume-Uni": "🇬🇧", "United Kingdom": "🇬🇧", UK: "🇬🇧", GB: "🇬🇧",
  // Bonus hors EU
  Canada: "🇨🇦", CA: "🇨🇦",
  "États-Unis": "🇺🇸", "United States": "🇺🇸", USA: "🇺🇸", US: "🇺🇸",
};

function flagFor(country: string | null | undefined): string {
  if (!country) return "🌍";
  const trimmed = country.trim();
  if (!trimmed) return "🌍";
  if (FLAGS[trimmed]) return FLAGS[trimmed];
  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase();
    if (FLAGS[upper]) return FLAGS[upper];
  }
  const lower = trimmed.toLowerCase();
  for (const key of Object.keys(FLAGS)) {
    if (key.toLowerCase() === lower) return FLAGS[key];
  }
  return "🌍";
}

type SerializedLog = Omit<OrderEmailLog, "confirmationReadyAt" | "shippingReadyAt" | "confirmationEmailSentAt" | "shippingEmailSentAt" | "createdAt" | "updatedAt"> & {
  confirmationReadyAt: string | null;
  shippingReadyAt: string | null;
  confirmationEmailSentAt: string | null;
  shippingEmailSentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type FilterKey = "all" | "pending" | "ready_confirmation" | "ready_shipping" | "ready_both";
type Tone = "neutral" | "amber" | "green" | "red";

export async function loader() {
  const snapshots = getDemoSnapshots();
  for (const snap of snapshots) {
    await upsertOrderEmailLog(snap);
  }
  const allLogs = await listOrderEmailLogs();
  const logs = allLogs.filter((l) => isDemoOrderId(l.shopifyOrderId));
  return { logs, isDemo: true };
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  if (!id) return { ok: false, error: "id manquant" };

  switch (intent) {
    case "save_tracking": {
      const carrier = (form.get("carrier") as string) || null;
      const trackingNumber = (form.get("trackingNumber") as string)?.trim() || null;
      await saveTracking(id, carrier, trackingNumber);
      return { ok: true };
    }
    case "mark_confirmation_ready":
      await markConfirmationReady(id);
      return { ok: true };
    case "mark_shipping_ready":
      try {
        await markShippingReady(id);
        return { ok: true };
      } catch (err) {
        if (err instanceof ShippingReadyError) {
          return { ok: false, error: err.message, intent: "mark_shipping_ready" };
        }
        throw err;
      }
    case "reset":
      await resetEmailStatus(id);
      return { ok: true };
    case "update_notes": {
      const notes = (form.get("notes") as string)?.trim() || null;
      await updateNotes(id, notes);
      return { ok: true };
    }
    default:
      return { ok: false, error: `intent inconnu: ${intent}` };
  }
}

function emailDisplayStatus(
  side: "confirmation" | "shipping",
  log: SerializedLog,
): { label: "Brouillon" | "Prêt" | "Envoyé" | "Erreur"; tone: Tone } {
  const sentAt = side === "confirmation" ? log.confirmationEmailSentAt : log.shippingEmailSentAt;
  const readyAt = side === "confirmation" ? log.confirmationReadyAt : log.shippingReadyAt;
  if (log.lastEmailError) return { label: "Erreur", tone: "red" };
  if (sentAt) return { label: "Envoyé", tone: "green" };
  if (readyAt) return { label: "Prêt", tone: "amber" };
  return { label: "Brouillon", tone: "neutral" };
}

function toneStyles(tone: Tone): { bg: string; fg: string; border: string } {
  switch (tone) {
    case "green":
      return { bg: T.greenBg, fg: T.green, border: T.greenBorder };
    case "amber":
      return { bg: T.amberBg, fg: T.amber, border: T.amberBorder };
    case "red":
      return { bg: T.redBg, fg: T.red, border: T.redBorder };
    default:
      return { bg: T.neutralBg, fg: T.neutral, border: T.neutralBorder };
  }
}

function fulfillmentDisplay(s: string): { label: string; tone: Tone } {
  switch (s) {
    case "FULFILLED":
      return { label: "Expédié", tone: "green" };
    case "PARTIALLY_FULFILLED":
      return { label: "Partiel", tone: "amber" };
    case "IN_PROGRESS":
      return { label: "En cours", tone: "amber" };
    default:
      return { label: "À préparer", tone: "neutral" };
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit" });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function ShippingLocalPage() {
  const { logs, isDemo } = useLoaderData<typeof loader>() as unknown as { logs: SerializedLog[]; isDemo: boolean };
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const selected = useMemo(
    () => (selectedId ? logs.find((l) => l.id === selectedId) ?? null : null),
    [selectedId, logs],
  );

  const filtered = useMemo(() => {
    let list = logs;
    if (filter !== "all") list = list.filter((l) => l.emailStatus === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (l) =>
          l.orderName.toLowerCase().includes(q) ||
          l.customerName.toLowerCase().includes(q) ||
          l.customerEmail.toLowerCase().includes(q) ||
          (l.trackingNumber ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [logs, filter, search]);

  const counts = useMemo(() => {
    const c = { all: logs.length, pending: 0, ready_confirmation: 0, ready_shipping: 0, ready_both: 0 };
    for (const l of logs) {
      if (l.emailStatus in c) (c as Record<string, number>)[l.emailStatus] += 1;
    }
    return c;
  }, [logs]);

  const kpis = useMemo(() => {
    let toPrepare = 0;
    let emailsReady = 0;
    let shipped = 0;
    for (const l of logs) {
      if (l.emailStatus === "pending") toPrepare += 1;
      else emailsReady += 1;
      if (l.fulfillmentStatus === "FULFILLED") shipped += 1;
    }
    return { toPrepare, emailsReady, shipped };
  }, [logs]);

  return (
    <div
      style={{
        background: T.bg,
        minHeight: "100vh",
        padding: "32px 24px 48px",
        color: T.text,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
      }}
    >
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <header style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: T.aubergineDeep, letterSpacing: "-0.02em" }}>
              Expédition &amp; Emails
            </h1>
            {isDemo && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: T.amberBg,
                  color: T.amber,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  border: `1px solid ${T.amberBorder}`,
                }}
                title="Données fictives — aucun email réel envoyé"
              >
                <span style={{ width: 6, height: 6, borderRadius: 999, background: T.amber }} />
                Démo
              </span>
            )}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 999,
                background: T.aubergineSoft,
                color: T.aubergineDeep,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                border: `1px solid ${T.aubergineBorder}`,
              }}
              title="Route locale standalone, sans Shopify CLI"
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: T.aubergine }} />
              Local
            </span>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: T.muted }}>
            Données fictives — aucun email réel envoyé. Testez modal, tracking, previews et statuts.
          </p>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
            marginBottom: 24,
          }}
        >
          <KpiCard label="Commandes à préparer" value={kpis.toPrepare} icon="📦" />
          <KpiCard label="Emails prêts" value={kpis.emailsReady} icon="✉️" />
          <KpiCard label="Colis expédiés" value={kpis.shipped} icon="🚚" />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <FilterTab label="Toutes" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterTab label="En attente" count={counts.pending} active={filter === "pending"} onClick={() => setFilter("pending")} />
          <FilterTab label="Conf. prête" count={counts.ready_confirmation} active={filter === "ready_confirmation"} onClick={() => setFilter("ready_confirmation")} />
          <FilterTab label="Exp. prête" count={counts.ready_shipping} active={filter === "ready_shipping"} onClick={() => setFilter("ready_shipping")} />
          <FilterTab label="Les deux" count={counts.ready_both} active={filter === "ready_both"} onClick={() => setFilter("ready_both")} />
        </div>

        <div style={{ position: "relative", marginBottom: 16 }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 14,
              top: "50%",
              transform: "translateY(-50%)",
              color: T.dim,
              fontSize: 14,
              pointerEvents: "none",
            }}
          >
            ⌕
          </span>
          <input
            type="search"
            placeholder="Rechercher : #commande, client, email, tracking…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              padding: "11px 14px 11px 36px",
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              fontSize: 13,
              background: T.card,
              color: T.text,
              boxSizing: "border-box",
              outline: "none",
            }}
          />
        </div>

        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: T.shadow,
          }}
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: T.cardSoft, borderBottom: `1px solid ${T.border}` }}>
                  <Th>Commande</Th>
                  <Th>Client</Th>
                  <Th>Pays</Th>
                  <Th>Produits</Th>
                  <Th>Fulfillment</Th>
                  <Th>Confirmation</Th>
                  <Th>Expédition</Th>
                  <Th>Tracking</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ padding: 32, textAlign: "center", color: T.muted }}>
                      Aucune commande
                    </td>
                  </tr>
                ) : (
                  filtered.map((l) => {
                    const isHovered = hoveredId === l.id;
                    const ful = fulfillmentDisplay(l.fulfillmentStatus);
                    const confStatus = emailDisplayStatus("confirmation", l);
                    const shipStatus = emailDisplayStatus("shipping", l);
                    return (
                      <tr
                        key={l.id}
                        onMouseEnter={() => setHoveredId(l.id)}
                        onMouseLeave={() => setHoveredId(null)}
                        style={{
                          borderBottom: `1px solid ${T.borderSoft}`,
                          background: isHovered ? T.rowHover : "transparent",
                          transition: "background 0.15s ease",
                        }}
                      >
                        <Td>
                          <div style={{ fontWeight: 600, color: T.aubergineDeep }}>{l.orderName}</div>
                          <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>{fmtDate(l.createdAt)}</div>
                        </Td>
                        <Td>
                          <div style={{ color: T.text }}>{l.customerName}</div>
                          <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>{l.customerEmail || "—"}</div>
                        </Td>
                        <Td>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 16 }} aria-hidden>
                              {flagFor(l.country)}
                            </span>
                            <span style={{ color: T.text }}>{l.country || "—"}</span>
                          </span>
                        </Td>
                        <Td style={{ maxWidth: 240 }}>
                          <div style={{ fontSize: 12, color: T.text, lineHeight: 1.5 }}>{l.productsSummary || "—"}</div>
                        </Td>
                        <Td>
                          <StatusPill {...toneStyles(ful.tone)} label={ful.label} />
                        </Td>
                        <Td>
                          <StatusPill {...toneStyles(confStatus.tone)} label={confStatus.label} />
                          {l.confirmationReadyAt && (
                            <div style={{ fontSize: 10, color: T.dim, marginTop: 4 }}>{fmtDate(l.confirmationReadyAt)}</div>
                          )}
                        </Td>
                        <Td>
                          <StatusPill {...toneStyles(shipStatus.tone)} label={shipStatus.label} />
                          {l.shippingReadyAt && (
                            <div style={{ fontSize: 10, color: T.dim, marginTop: 4 }}>{fmtDate(l.shippingReadyAt)}</div>
                          )}
                        </Td>
                        <Td>
                          {l.trackingNumber ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <span style={{ fontSize: 11, color: T.muted }}>{displayCarrier(l.carrier, l.country)}</span>
                              <CopyChip value={l.trackingNumber} />
                            </div>
                          ) : (
                            <span style={{ color: T.dim }}>—</span>
                          )}
                        </Td>
                        <Td>
                          <button
                            type="button"
                            onClick={() => setSelectedId(l.id)}
                            style={{
                              padding: "7px 14px",
                              borderRadius: 8,
                              border: `1px solid ${T.aubergineBorder}`,
                              background: isHovered ? T.aubergine : T.card,
                              color: isHovered ? "#fff" : T.aubergine,
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 600,
                              letterSpacing: "0.02em",
                              transition: "all 0.15s ease",
                            }}
                          >
                            Gérer
                          </button>
                        </Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {selected && <DetailModal log={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function KpiCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: "18px 20px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        boxShadow: T.shadow,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: T.aubergineSoft,
          border: `1px solid ${T.aubergineBorder}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          flexShrink: 0,
        }}
        aria-hidden
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: T.aubergineDeep,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontSize: 10,
            color: T.muted,
            marginTop: 6,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

function FilterTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 14px",
        borderRadius: 999,
        border: `1px solid ${active ? T.aubergine : T.border}`,
        background: active ? T.aubergine : T.card,
        color: active ? "#fff" : T.text,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        transition: "all 0.15s ease",
      }}
    >
      <span>{label}</span>
      <span
        style={{
          fontSize: 10,
          padding: "1px 7px",
          borderRadius: 999,
          background: active ? "rgba(255,255,255,0.18)" : T.cardSoft,
          color: active ? "#fff" : T.muted,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count}
      </span>
    </button>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "12px 14px",
        textAlign: "left",
        fontWeight: 600,
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: T.muted,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "14px 14px", verticalAlign: "top", ...style }}>{children}</td>;
}

function StatusPill({ bg, fg, border, label }: { bg: string; fg: string; border: string; label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 9px",
        borderRadius: 999,
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
        letterSpacing: "0.01em",
      }}
    >
      {label}
    </span>
  );
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(value).catch(() => {});
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copié" : "Copier le numéro de suivi"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        borderRadius: 6,
        border: `1px solid ${T.borderSoft}`,
        background: copied ? T.greenBg : T.cardSoft,
        color: T.text,
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        cursor: "pointer",
        letterSpacing: "0.02em",
        transition: "all 0.15s ease",
      }}
    >
      <span>{value}</span>
      <span
        aria-hidden
        style={{
          color: copied ? T.green : T.dim,
          fontSize: 11,
          fontFamily: "system-ui, sans-serif",
          fontWeight: 600,
        }}
      >
        {copied ? "✓" : "⧉"}
      </span>
    </button>
  );
}

function DetailModal({ log, onClose }: { log: SerializedLog; onClose: () => void }) {
  const fetcher = useFetcher();
  const suggestedCarrier = defaultCarrierForCountry(log.country) ?? "";
  const [carrier, setCarrier] = useState(log.carrier ?? suggestedCarrier);
  const [trackingNumber, setTrackingNumber] = useState(log.trackingNumber ?? "");
  const [notes, setNotes] = useState(log.notes ?? "");
  const [previewType, setPreviewType] = useState<"confirmation" | "shipping" | null>(null);
  const [trackingCopied, setTrackingCopied] = useState(false);

  const carrierIsSuggestion = !log.carrier && Boolean(suggestedCarrier);
  const busy = fetcher.state !== "idle";
  const hasTracking = Boolean(carrier && trackingNumber.trim());

  const confStatus = emailDisplayStatus("confirmation", log);
  const shipStatus = emailDisplayStatus("shipping", log);

  const response = fetcher.data as { ok?: boolean; error?: string; intent?: string } | undefined;
  const serverError = response && response.ok === false ? response.error : undefined;
  const serverErrorIntent = response && response.ok === false ? response.intent : undefined;

  const copyTracking = () => {
    if (!trackingNumber.trim()) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(trackingNumber.trim()).catch(() => {});
    }
    setTrackingCopied(true);
    window.setTimeout(() => setTrackingCopied(false), 1200);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(31, 20, 36, 0.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 24,
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card,
          borderRadius: 16,
          width: "100%",
          maxWidth: 880,
          marginTop: 40,
          marginBottom: 40,
          boxShadow: T.shadowLg,
          overflow: "hidden",
          border: `1px solid ${T.border}`,
        }}
      >
        <div
          style={{
            padding: "22px 28px",
            borderBottom: `1px solid ${T.borderSoft}`,
            background: T.cardSoft,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.aubergineDeep, letterSpacing: "-0.01em" }}>
              {log.orderName}
            </div>
            <div style={{ fontSize: 13, color: T.muted, marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>{log.customerName}</span>
              <span style={{ color: T.dim }}>·</span>
              <span>{log.customerEmail || "—"}</span>
              <span style={{ color: T.dim }}>·</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span aria-hidden>{flagFor(log.country)}</span>
                {log.country || "—"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
              <StatusPill {...toneStyles(confStatus.tone)} label={`Conf · ${confStatus.label}`} />
              <StatusPill {...toneStyles(shipStatus.tone)} label={`Exp · ${shipStatus.label}`} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: `1px solid ${T.border}`,
              background: T.card,
              fontSize: 18,
              cursor: "pointer",
              color: T.muted,
              width: 32,
              height: 32,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
            aria-label="Fermer"
          >
            ×
          </button>
        </div>

        <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 26 }}>
          <Section title="Produits">
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.7,
                color: T.text,
                padding: "12px 14px",
                background: T.cardSoft,
                borderRadius: 10,
                border: `1px solid ${T.borderSoft}`,
              }}
            >
              {log.productsSummary || "—"}
            </div>
          </Section>

          <Section title="Tracking">
            <fetcher.Form method="post" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input type="hidden" name="intent" value="save_tracking" />
              <input type="hidden" name="id" value={log.id} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Transporteur">
                  <select
                    name="carrier"
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">— Sélectionner —</option>
                    {CARRIERS.map((c) => (
                      <option key={c} value={c}>
                        {CARRIER_LABELS[c]}
                      </option>
                    ))}
                  </select>
                  {carrierIsSuggestion && (
                    <span style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
                      Suggestion d'après {log.country || "le pays"} :{" "}
                      <strong style={{ color: T.aubergine }}>{displayCarrier(suggestedCarrier, log.country)}</strong>.
                    </span>
                  )}
                </Field>
                <Field label="Numéro de suivi">
                  <div style={{ position: "relative" }}>
                    <input
                      type="text"
                      name="trackingNumber"
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="ex. 6B12345678"
                      style={{
                        ...inputStyle,
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                        paddingRight: 78,
                        letterSpacing: "0.03em",
                      }}
                    />
                    <button
                      type="button"
                      onClick={copyTracking}
                      disabled={!trackingNumber.trim()}
                      style={{
                        position: "absolute",
                        right: 6,
                        top: "50%",
                        transform: "translateY(-50%)",
                        padding: "5px 10px",
                        borderRadius: 6,
                        border: `1px solid ${T.borderSoft}`,
                        background: trackingCopied ? T.greenBg : T.cardSoft,
                        color: trackingCopied ? T.green : T.muted,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: trackingNumber.trim() ? "pointer" : "not-allowed",
                        opacity: trackingNumber.trim() ? 1 : 0.5,
                      }}
                    >
                      {trackingCopied ? "Copié ✓" : "Copier"}
                    </button>
                  </div>
                </Field>
              </div>
              {log.trackingUrl && (
                <div
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    padding: "10px 12px",
                    background: T.aubergineSoft,
                    borderRadius: 8,
                    border: `1px solid ${T.aubergineBorder}`,
                    wordBreak: "break-all",
                  }}
                >
                  <span style={{ color: T.aubergineDeep, fontWeight: 600 }}>Lien de suivi : </span>
                  <a href={log.trackingUrl} target="_blank" rel="noreferrer" style={{ color: T.aubergine, textDecoration: "underline" }}>
                    {log.trackingUrl}
                  </a>
                </div>
              )}
              <div>
                <button type="submit" disabled={busy} style={primaryBtn}>
                  {busy ? "Enregistrement…" : "Enregistrer le tracking"}
                </button>
              </div>
            </fetcher.Form>
          </Section>

          <Section title="Email de confirmation">
            <Row>
              <div style={{ fontSize: 13, color: T.text }}>
                <StatusPill {...toneStyles(confStatus.tone)} label={confStatus.label} />
                {log.confirmationReadyAt && (
                  <span style={{ marginLeft: 10, color: T.muted, fontSize: 12 }}>
                    le <strong>{fmtDateTime(log.confirmationReadyAt)}</strong>
                  </span>
                )}
              </div>
              <ButtonRow>
                <button type="button" onClick={() => setPreviewType("confirmation")} style={secondaryBtn}>
                  Prévisualiser
                </button>
                <fetcher.Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="mark_confirmation_ready" />
                  <input type="hidden" name="id" value={log.id} />
                  <button type="submit" disabled={busy} style={primaryBtn}>
                    Marquer comme prêt
                  </button>
                </fetcher.Form>
              </ButtonRow>
            </Row>
          </Section>

          <Section title="Email d'expédition">
            <Row>
              <div style={{ fontSize: 13, color: T.text }}>
                <StatusPill {...toneStyles(shipStatus.tone)} label={shipStatus.label} />
                {log.shippingReadyAt && (
                  <span style={{ marginLeft: 10, color: T.muted, fontSize: 12 }}>
                    le <strong>{fmtDateTime(log.shippingReadyAt)}</strong>
                  </span>
                )}
                {!log.shippingReadyAt && !hasTracking && (
                  <span style={{ marginLeft: 10, color: T.muted, fontSize: 12 }}>
                    Renseigner d'abord transporteur + tracking
                  </span>
                )}
              </div>
              <ButtonRow>
                <button
                  type="button"
                  onClick={() => setPreviewType("shipping")}
                  style={secondaryBtn}
                  disabled={!log.trackingNumber}
                  title={!log.trackingNumber ? "Renseigner un numéro de suivi pour prévisualiser" : ""}
                >
                  Prévisualiser
                </button>
                <fetcher.Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="mark_shipping_ready" />
                  <input type="hidden" name="id" value={log.id} />
                  <button type="submit" disabled={busy || !log.trackingNumber} style={primaryBtn}>
                    Marquer comme prêt
                  </button>
                </fetcher.Form>
              </ButtonRow>
            </Row>
            {serverErrorIntent === "mark_shipping_ready" && serverError && (
              <div
                role="alert"
                style={{
                  marginTop: 10,
                  padding: "10px 12px",
                  background: T.redBg,
                  border: `1px solid ${T.redBorder}`,
                  borderRadius: 8,
                  color: T.red,
                  fontSize: 12,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span aria-hidden>⚠</span>
                <span>{serverError}</span>
              </div>
            )}
          </Section>

          <Section title="Notes internes">
            <fetcher.Form method="post" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input type="hidden" name="intent" value="update_notes" />
              <input type="hidden" name="id" value={log.id} />
              <textarea
                name="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Notes pour le suivi interne…"
                style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
              />
              <div>
                <button type="submit" disabled={busy} style={secondaryBtn}>
                  Enregistrer la note
                </button>
              </div>
            </fetcher.Form>
          </Section>

          <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: "pointer", fontSize: 11, color: T.dim, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>
              Debug
            </summary>
            <fetcher.Form method="post" style={{ marginTop: 10 }}>
              <input type="hidden" name="intent" value="reset" />
              <input type="hidden" name="id" value={log.id} />
              <button
                type="submit"
                disabled={busy}
                style={{ ...secondaryBtn, color: T.red, borderColor: T.redBorder, background: T.redBg }}
              >
                Réinitialiser les statuts emails
              </button>
            </fetcher.Form>
          </details>
        </div>
      </div>

      {previewType && (
        <PreviewModal
          logId={log.id}
          orderName={log.orderName}
          type={previewType}
          onClose={() => setPreviewType(null)}
        />
      )}
    </div>
  );
}

function PreviewModal({
  logId,
  orderName,
  type,
  onClose,
}: {
  logId: string;
  orderName: string;
  type: "confirmation" | "shipping";
  onClose: () => void;
}) {
  const src = `/shipping-local/preview?logId=${encodeURIComponent(logId)}&type=${type}`;
  const title = type === "confirmation" ? "Confirmation de commande" : "Email d'expédition";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(31, 20, 36, 0.78)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card,
          borderRadius: 18,
          width: "min(92vw, 980px)",
          height: "92vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: T.shadowLg,
          border: `1px solid ${T.border}`,
        }}
      >
        <div
          style={{
            padding: "16px 22px",
            borderBottom: `1px solid ${T.borderSoft}`,
            background: T.cardSoft,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: T.muted,
                fontWeight: 600,
              }}
            >
              Prévisualisation — {orderName}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.aubergineDeep, marginTop: 2 }}>
              {title}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: `1px solid ${T.border}`,
                background: T.card,
                color: T.muted,
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Ouvrir
            </a>
            <button
              type="button"
              onClick={onClose}
              style={{
                border: `1px solid ${T.border}`,
                background: T.card,
                fontSize: 18,
                cursor: "pointer",
                color: T.muted,
                width: 32,
                height: 32,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              aria-label="Fermer"
            >
              ×
            </button>
          </div>
        </div>
        <div style={{ flex: 1, background: "#F7F2EC", padding: 12, overflow: "auto" }}>
          <iframe
            title={`Email preview ${type}`}
            src={src}
            style={{
              width: "100%",
              height: "100%",
              border: 0,
              background: "#F7F2EC",
              borderRadius: 10,
              boxShadow: "0 4px 16px rgba(31,20,36,0.08)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: T.aubergine,
          fontWeight: 700,
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11, color: T.muted, fontWeight: 600, letterSpacing: "0.02em" }}>{label}</span>
      {children}
    </label>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
      {children}
    </div>
  );
}

function ButtonRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>;
}

const inputStyle: React.CSSProperties = {
  padding: "10px 13px",
  border: `1px solid ${T.border}`,
  borderRadius: 8,
  fontSize: 13,
  background: T.card,
  color: T.text,
  width: "100%",
  boxSizing: "border-box",
  outline: "none",
};

const primaryBtn: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: `1px solid ${T.aubergine}`,
  background: T.aubergine,
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: "0.02em",
};

const secondaryBtn: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: `1px solid ${T.border}`,
  background: T.card,
  color: T.text,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: "0.02em",
};
