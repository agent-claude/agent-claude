import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const T = {
  bg: "#f8fafc",
  card: "#ffffff",
  border: "#e2e8f0",
  text: "#0f172a",
  muted: "#64748b",
  dim: "#94a3b8",
  accent: "#6366f1",
  green: "#059669",
  greenBg: "#f0fdf4",
  red: "#dc2626",
  redBg: "#fef2f2",
  orange: "#d97706",
  orangeBg: "#fffbeb",
  purple: "#7c3aed",
  purpleBg: "#f5f3ff",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
};

const SECTIONS = [
  {
    href: "/app/ugc",
    label: "UGC & Collabs",
    desc: "Créateurs · Influenceurs · Cafés · Partenariats",
    icon: "🤝",
    accent: T.accent,
    bg: "#eef2ff",
    bdr: "#c7d2fe",
  },
  {
    href: "/app/recettes",
    label: "Livret Recettes",
    desc: "Clients ayant commandé · Envoi PDF bilingue FR/EN",
    icon: "📖",
    accent: T.purple,
    bg: T.purpleBg,
    bdr: "#ddd6fe",
  },
  {
    href: "/app/produits-offerts",
    label: "Produits offerts",
    desc: "UGC · Cafés · Collabs · Suivi COGS",
    icon: "🎁",
    accent: T.green,
    bg: T.greenBg,
    bdr: "#86efac",
  },
  {
    href: "/app/expenses",
    label: "Dépenses",
    desc: "Publicité · Packaging · Shopify · Événements",
    icon: "💸",
    accent: T.red,
    bg: T.redBg,
    bdr: "#fca5a5",
  },
  {
    href: "/app/todo",
    label: "To Do",
    desc: "Tâches en cours · UGC · Général",
    icon: "✅",
    accent: T.orange,
    bg: T.orangeBg,
    bdr: "#fde68a",
  },
];

export default function Dashboard() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        padding: "40px 24px 60px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 800, margin: "0 auto" }}>

        <div style={{ marginBottom: 36 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>
            Agent Claude
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: T.muted }}>
            Tableau de bord · Laya
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
          {SECTIONS.map((s) => (
            <a
              key={s.href}
              href={s.href}
              style={{
                display: "block",
                background: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: 16,
                padding: "20px 22px",
                textDecoration: "none",
                boxShadow: T.shadow,
                transition: "box-shadow 0.15s, border-color 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.borderColor = s.bdr;
                (e.currentTarget as HTMLAnchorElement).style.boxShadow = `0 4px 12px rgba(0,0,0,0.1)`;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.borderColor = T.border;
                (e.currentTarget as HTMLAnchorElement).style.boxShadow = T.shadow;
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: s.bg,
                  border: `1px solid ${s.bdr}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  marginBottom: 14,
                }}
              >
                {s.icon}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 5 }}>
                {s.label}
              </div>
              <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>
                {s.desc}
              </div>
            </a>
          ))}
        </div>

      </div>
    </div>
  );
}
