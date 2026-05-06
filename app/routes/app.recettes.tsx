import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Constante PDF ────────────────────────────────────────────────────────────

const PDF_LINK = "https://cdn.shopify.com/s/files/1/0963/8576/1664/files/Ebook_-_Recettes_Ube_Laya_compressed.pdf?v=1778053423";

// ─── Détection langue ─────────────────────────────────────────────────────────

const FR_COUNTRIES = new Set(["FR", "BE", "CH"]);

function detectLang(c: ShopifyCustomer): "FR" | "EN" {
  const country = c.defaultAddress?.countryCodeV2;
  if (country) return FR_COUNTRIES.has(country) ? "FR" : "EN";
  const locale = c.locale ?? "";
  return locale.toLowerCase().startsWith("fr") ? "FR" : "EN";
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const CUSTOMERS_QUERY = `
  query GetCustomers($cursor: String) {
    customers(first: 100, query: "orders_count:>0", after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          displayName
          email
          numberOfOrders
          amountSpent {
            amount
            currencyCode
          }
          createdAt
          updatedAt
          locale
          defaultAddress {
            countryCodeV2
          }
          lastOrder {
            id
            name
            createdAt
          }
        }
      }
    }
  }
`;

type ShopifyCustomer = {
  id: string;
  displayName: string;
  email: string | null;
  numberOfOrders: number;
  amountSpent: { amount: string; currencyCode: string };
  createdAt: string;
  updatedAt: string;
  lastOrder: { id: string; name: string; createdAt: string } | null;
  locale: string | null;
  defaultAddress: { countryCodeV2: string } | null;
};

async function fetchAllCustomers(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> }
): Promise<ShopifyCustomer[]> {
  const all: ShopifyCustomer[] = [];
  let cursor: string | null = null;

  do {
    const res = await admin.graphql(CUSTOMERS_QUERY, {
      variables: cursor ? { cursor } : {},
    });
    const json = await res.json() as {
      data: {
        customers: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: ShopifyCustomer }[];
        };
      };
    };

    const page = json.data?.customers;
    if (!page) break;

    all.push(...page.edges.map((e) => e.node));

    if (page.pageInfo.hasNextPage) {
      cursor = page.pageInfo.endCursor;
    } else {
      cursor = null;
    }
  } while (cursor);

  return all;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const [customers, livrets] = await Promise.all([
    fetchAllCustomers(admin),
    prisma.recetteLivret.findMany(),
  ]);

  const livretMap = new Map(livrets.map((l) => [l.customerId, l]));

  return { customers, livretMap: Object.fromEntries(livretMap), pdfLink: PDF_LINK };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const customerId = String(form.get("customerId") ?? "");
  const email = String(form.get("email") ?? "") || null;
  const name = String(form.get("name") ?? "") || null;

  if (!customerId) return { ok: false };

  if (intent === "marquer_envoye") {
    await prisma.recetteLivret.upsert({
      where: { customerId },
      create: { customerId, email, name, status: "envoye", sentAt: new Date() },
      update: { status: "envoye", sentAt: new Date(), email, name },
    });
  }

  if (intent === "remettre_a_envoyer") {
    await prisma.recetteLivret.upsert({
      where: { customerId },
      create: { customerId, email, name, status: "a_envoyer", sentAt: null },
      update: { status: "a_envoyer", sentAt: null, email, name },
    });
  }

  return { ok: true };
};

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg: "#f8fafc",
  card: "#ffffff",
  border: "#e2e8f0",
  text: "#0f172a",
  muted: "#64748b",
  dim: "#94a3b8",
  accent: "#7c3aed",
  purple: "#7c3aed",
  purpleBg: "#f5f3ff",
  purpleBdr: "#ddd6fe",
  green: "#059669",
  greenBg: "#f0fdf4",
  greenBdr: "#86efac",
  orange: "#d97706",
  orangeBg: "#fffbeb",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
};

const inp: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
  background: "#fff",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtAmount(amount: string, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(Number(amount));
}

// ─── Contenu email bilingue ───────────────────────────────────────────────────

const EMAIL_CONTENT = {
  FR: {
    subject:    "Ton livret recettes Ube Laya est prêt 💜",
    header:     "Ton livret recettes est prêt 💜",
    greeting:   "Hello 💜",
    intro:      "Merci encore pour ta commande Ube Laya.",
    body:       "Pour t'aider à profiter au maximum de ta poudre d'ube, on t'offre notre livret recettes : <strong>25 idées simples, gourmandes et réconfortantes</strong> à préparer à la maison.",
    bodyTxt:    "Pour t'aider à profiter au maximum de ta poudre d'ube, on t'offre notre livret recettes : 25 idées simples, gourmandes et réconfortantes à préparer à la maison.",
    menuLabel:  "Au menu",
    recipes:    "Ube Latte &nbsp;·&nbsp; Pancakes Ube &nbsp;·&nbsp; Cookies moelleux<br>Tiramisu Ube &nbsp;·&nbsp; Smoothie violet &nbsp;·&nbsp; Banana Bread",
    recipesTxt: "– Ube Latte\n– Pancakes Ube\n– Cookies moelleux\n– Tiramisu Ube\n– Smoothie violet\n– Banana Bread",
    moreIdeas:  "et plein d'autres idées violettes ✨",
    cta:        "Télécharger le livret Ube Laya &nbsp;→",
    ctaTxt:     "→ Télécharger le livret Ube Laya :",
    closing:    "À très vite,",
    brand:      "Ube Laya",
    footer:     "Ube Laya · Poudre d'ube premium",
  },
  EN: {
    subject:    "Your Ube Laya recipe booklet is ready 💜",
    header:     "Your recipe booklet is ready 💜",
    greeting:   "Hello 💜",
    intro:      "Thank you for your Ube Laya order.",
    body:       "To help you make the most of your ube powder, we're gifting you our recipe booklet: <strong>25 simple, indulgent and comforting ideas</strong> to make at home.",
    bodyTxt:    "To help you make the most of your ube powder, we're gifting you our recipe booklet: 25 simple, indulgent and comforting ideas to make at home.",
    menuLabel:  "On the menu",
    recipes:    "Ube Latte &nbsp;·&nbsp; Ube Pancakes &nbsp;·&nbsp; Soft Cookies<br>Ube Tiramisu &nbsp;·&nbsp; Purple Smoothie &nbsp;·&nbsp; Banana Bread",
    recipesTxt: "– Ube Latte\n– Ube Pancakes\n– Soft Cookies\n– Ube Tiramisu\n– Purple Smoothie\n– Banana Bread",
    moreIdeas:  "and many more purple ideas ✨",
    cta:        "Download your Ube Laya booklet &nbsp;→",
    ctaTxt:     "→ Download your Ube Laya booklet:",
    closing:    "See you soon,",
    brand:      "Ube Laya",
    footer:     "Ube Laya · Premium ube powder",
  },
} as const;

function buildEmailHtml(lienPdf: string, lang: "FR" | "EN"): string {
  const c = EMAIL_CONTENT[lang];
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${c.subject}</title></head>
<body style="margin:0;padding:0;background:#faf5f0;font-family:Georgia,'Times New Roman',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf5f0;">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(124,58,237,0.08);">
        <tr>
          <td style="background:#7c3aed;padding:36px 40px;text-align:center;">
            <p style="margin:0;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#c4b5fd;font-family:Georgia,serif;">Ube Laya</p>
            <p style="margin:10px 0 0;font-size:22px;font-weight:400;color:#ffffff;font-family:Georgia,serif;line-height:1.5;">${c.header}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 8px;color:#2d2438;font-family:Georgia,serif;font-size:15px;line-height:1.9;">
            <p style="margin:0 0 18px;">${c.greeting}</p>
            <p style="margin:0 0 18px;">${c.intro}</p>
            <p style="margin:0 0 28px;">${c.body}</p>
            <table cellpadding="0" cellspacing="0" width="100%" style="background:#faf5f0;border-radius:12px;margin:0 0 32px;">
              <tr><td style="padding:22px 28px;">
                <p style="margin:0 0 14px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#a794b8;font-family:Georgia,serif;">${c.menuLabel}</p>
                <p style="margin:0;font-size:14px;color:#4a3f55;line-height:2.1;font-family:Georgia,serif;">
                  ${c.recipes}<br>
                  <span style="color:#a794b8;font-style:italic;">${c.moreIdeas}</span>
                </p>
              </td></tr>
            </table>
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr><td align="center" style="padding:0 0 36px;">
                <a href="${lienPdf}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;font-family:Georgia,serif;font-size:14px;letter-spacing:0.06em;padding:15px 40px;border-radius:50px;">${c.cta}</a>
              </td></tr>
            </table>
            <p style="margin:0 0 36px;font-size:14px;color:#9d8ca8;">${c.closing}<br><span style="color:#7c3aed;font-weight:bold;">${c.brand}</span></p>
          </td>
        </tr>
        <tr>
          <td style="background:#faf5f0;padding:16px 40px;text-align:center;border-top:1px solid #ede8f5;">
            <p style="margin:0;font-size:11px;color:#c4b5d0;letter-spacing:0.08em;">${c.footer}</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildEmailTexte(lienPdf: string, lang: "FR" | "EN"): string {
  const c = EMAIL_CONTENT[lang];
  return `${c.greeting}

${c.intro}

${c.bodyTxt}

${c.menuLabel} :
${c.recipesTxt}
– ${c.moreIdeas}

${c.ctaTxt}
${lienPdf}

${c.closing}
${c.brand}`;
}

// ─── Row client ───────────────────────────────────────────────────────────────

type LivertEntry = { status: string; sentAt: string | null } | undefined;

function ClientRow({
  c,
  livret,
  lang,
  i,
}: {
  c: ShopifyCustomer;
  livret: LivertEntry;
  lang: "FR" | "EN";
  i: number;
}) {
  const fetcher = useFetcher();

  const optimisticStatus =
    fetcher.formData?.get("intent") === "marquer_envoye"
      ? "envoye"
      : fetcher.formData?.get("intent") === "remettre_a_envoyer"
      ? "a_envoyer"
      : livret?.status ?? "a_envoyer";

  const isEnvoye = optimisticStatus === "envoye";
  const rowBg = i % 2 === 0 ? "#fff" : "#f8fafc";
  const cell: React.CSSProperties = { padding: "10px 12px", color: T.text, fontSize: 13 };

  return (
    <tr style={{ borderTop: `1px solid ${T.border}`, background: rowBg }}>
      <td style={{ ...cell, fontWeight: 600, minWidth: 160 }}>
        {c.displayName || "—"}
      </td>

      <td style={{ ...cell, color: T.muted, minWidth: 200 }}>
        {c.email || "—"}
      </td>

      <td style={{ ...cell, textAlign: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 99, background: "#eef2ff", color: "#4338ca" }}>
          {c.numberOfOrders}
        </span>
      </td>

      <td style={{ ...cell, fontVariantNumeric: "tabular-nums", color: T.muted }}>
        {fmtAmount(c.amountSpent.amount, c.amountSpent.currencyCode)}
      </td>

      {/* Colonne Langue */}
      <td style={{ ...cell, textAlign: "center" }}>
        <span
          style={{
            display: "inline-block",
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 10px",
            borderRadius: 99,
            letterSpacing: "0.06em",
            background: lang === "FR" ? "#eef2ff" : "#f0fdf4",
            color: lang === "FR" ? "#4338ca" : T.green,
          }}
        >
          {lang === "FR" ? "🇫🇷 FR" : "🇬🇧 EN"}
        </span>
      </td>

      <td style={cell}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 10px",
            borderRadius: 99,
            background: isEnvoye ? T.greenBg : T.orangeBg,
            color: isEnvoye ? T.green : T.orange,
            border: `1px solid ${isEnvoye ? T.greenBdr : "#fde68a"}`,
          }}
        >
          {isEnvoye ? "✓ Envoyé" : "À envoyer"}
        </span>
        {isEnvoye && livret?.sentAt && (
          <div style={{ fontSize: 11, color: T.dim, marginTop: 3 }}>{fmtDate(livret.sentAt)}</div>
        )}
      </td>

      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        <fetcher.Form method="post">
          <input type="hidden" name="customerId" value={c.id} />
          <input type="hidden" name="email" value={c.email ?? ""} />
          <input type="hidden" name="name" value={c.displayName ?? ""} />
          {!isEnvoye ? (
            <button
              name="intent"
              value="marquer_envoye"
              type="submit"
              style={{ background: T.purple, color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Marquer envoyé
            </button>
          ) : (
            <button
              name="intent"
              value="remettre_a_envoyer"
              type="submit"
              style={{ background: "none", color: T.muted, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Remettre à envoyer
            </button>
          )}
        </fetcher.Form>
      </td>
    </tr>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecettesPage() {
  const { customers, livretMap, pdfLink } = useLoaderData<typeof loader>();
  const [pdfLinkInput, setPdfLinkInput] = useState(
    pdfLink === "COLLER_ICI_LE_LIEN_DU_PDF" ? "" : pdfLink
  );
  const [showEmail, setShowEmail] = useState(false);
  const [emailTab, setEmailTab] = useState<"html" | "texte">("html");
  const [langPreview, setLangPreview] = useState<"FR" | "EN">("FR");
  const [copiedWhat, setCopiedWhat] = useState<null | "objet" | "html" | "texte">(null);

  const totalEligibles = customers.length;
  const envoyes = customers.filter((c) => livretMap[c.id]?.status === "envoye").length;
  const aEnvoyer = totalEligibles - envoyes;
  const tauxEnvoi = totalEligibles > 0 ? Math.round((envoyes / totalEligibles) * 100) : 0;

  const lienPdf = pdfLinkInput.trim() || "[LIEN_DU_PDF]";
  const emailObjet = EMAIL_CONTENT[langPreview].subject;
  const emailHtml  = buildEmailHtml(lienPdf, langPreview);
  const emailTexte = buildEmailTexte(lienPdf, langPreview);

  function copy(text: string, which: "objet" | "html" | "texte") {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedWhat(which);
      setTimeout(() => setCopiedWhat(null), 2000);
    });
  }

  const kpiStyle = (accentBg: string, accentBdr: string): React.CSSProperties => ({
    background: accentBg,
    border: `1px solid ${accentBdr}`,
    borderRadius: 14,
    padding: "16px 20px",
  });

  const tabBtn = (active: boolean): React.CSSProperties => ({
    fontSize: 12,
    fontWeight: 600,
    padding: "7px 18px",
    border: "none",
    background: "none",
    cursor: "pointer",
    color: active ? T.purple : T.muted,
    borderBottom: active ? `2px solid ${T.purple}` : "2px solid transparent",
    marginBottom: -1,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
  });

  const copyBtn = (active: boolean): React.CSSProperties => ({
    fontSize: 12,
    padding: "6px 16px",
    borderRadius: 8,
    border: "none",
    background: active ? T.green : T.purple,
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        padding: "32px 24px 60px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Livret Recettes</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: T.muted }}>
              Clients ayant commandé · Livret PDF "25 recettes à base d'ube" · FR / EN automatique
            </p>
          </div>
          <a href="/app" style={{ fontSize: 12, color: T.accent, textDecoration: "none", border: `1px solid ${T.purpleBdr}`, padding: "5px 14px", borderRadius: 8, background: T.purpleBg }}>
            ← Dashboard
          </a>
        </div>

        {/* Lien PDF */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 20px", marginBottom: 20, boxShadow: T.shadow, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
            Lien du PDF
          </div>
          <input
            type="url"
            value={pdfLinkInput}
            onChange={(e) => setPdfLinkInput(e.target.value)}
            placeholder="https://…"
            style={{ ...inp, flex: 1, minWidth: 260 }}
          />
          {pdfLinkInput && (
            <a href={pdfLinkInput} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: T.accent, textDecoration: "none", whiteSpace: "nowrap" }}>
              Tester le lien ↗
            </a>
          )}
        </div>

        {/* KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
          <div style={kpiStyle(T.purpleBg, T.purpleBdr)}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>Clients éligibles</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: T.purple }}>{totalEligibles}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>avec au moins 1 commande</div>
          </div>
          <div style={kpiStyle(T.greenBg, T.greenBdr)}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>Livrets envoyés</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: T.green }}>{envoyes}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>marqués comme envoyés</div>
          </div>
          <div style={kpiStyle(T.orangeBg, "#fde68a")}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>À envoyer</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: T.orange }}>{aEnvoyer}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>livrets en attente</div>
          </div>
          <div style={kpiStyle("#f0f9ff", "#bae6fd")}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, marginBottom: 4, letterSpacing: "0.06em" }}>Taux d'envoi</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0284c7" }}>{tauxEnvoi}%</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{envoyes} / {totalEligibles}</div>
          </div>
        </div>

        {/* Email prêt à copier */}
        <div style={{ background: T.card, border: `1px solid ${T.purpleBdr}`, borderRadius: 14, padding: "18px 22px", marginBottom: 24, boxShadow: T.shadow }}>

          <button
            type="button"
            onClick={() => setShowEmail((v) => !v)}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%" }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.purple }}>
              Email prêt à copier
            </span>
            <span style={{ fontSize: 11, color: T.dim, fontWeight: 400 }}>
              {showEmail ? "▲ Masquer" : "▼ Afficher"}
            </span>
          </button>

          {showEmail && (
            <div style={{ marginTop: 18 }}>

              {/* Sélecteur langue */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Langue
                </span>
                {(["FR", "EN"] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLangPreview(l)}
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      padding: "4px 14px",
                      borderRadius: 99,
                      border: `1.5px solid ${langPreview === l ? T.purple : T.border}`,
                      background: langPreview === l ? T.purpleBg : "#fff",
                      color: langPreview === l ? T.purple : T.muted,
                      cursor: "pointer",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {l === "FR" ? "🇫🇷 Français" : "🇬🇧 English"}
                  </button>
                ))}
                <span style={{ fontSize: 11, color: T.dim }}>
                  {langPreview === "FR" ? "France · Belgique · Suisse" : "All other countries"}
                </span>
              </div>

              {/* Objet */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Objet
                  </span>
                  <button
                    type="button"
                    onClick={() => copy(emailObjet, "objet")}
                    style={{ fontSize: 11, padding: "3px 11px", borderRadius: 6, border: `1px solid ${T.purpleBdr}`, background: copiedWhat === "objet" ? T.purpleBg : "#fff", color: copiedWhat === "objet" ? T.purple : T.muted, cursor: "pointer", fontWeight: 600 }}
                  >
                    {copiedWhat === "objet" ? "✓ Copié !" : "Copier"}
                  </button>
                </div>
                <div style={{ background: T.purpleBg, border: `1px solid ${T.purpleBdr}`, borderRadius: 8, padding: "11px 14px", fontSize: 13, color: T.text, fontWeight: 500, userSelect: "all" }}>
                  {emailObjet}
                </div>
              </div>

              {/* Tabs HTML / Texte */}
              <div style={{ display: "flex", marginBottom: 12, borderBottom: `1px solid ${T.border}` }}>
                <button type="button" onClick={() => setEmailTab("html")} style={tabBtn(emailTab === "html")}>Version HTML</button>
                <button type="button" onClick={() => setEmailTab("texte")} style={tabBtn(emailTab === "texte")}>Version texte</button>
              </div>

              {/* HTML */}
              {emailTab === "html" && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: T.dim }}>Coller dans Klaviyo, Mailchimp ou tout éditeur HTML</span>
                    <button type="button" onClick={() => copy(emailHtml, "html")} style={copyBtn(copiedWhat === "html")}>
                      {copiedWhat === "html" ? "✓ Copié !" : "Copier le HTML"}
                    </button>
                  </div>
                  <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: T.dim, textTransform: "uppercase", letterSpacing: "0.08em", padding: "7px 14px", background: "#f1f5f9", borderBottom: `1px solid ${T.border}` }}>
                      Aperçu
                    </div>
                    <iframe
                      srcDoc={emailHtml}
                      title="Email preview"
                      style={{ width: "100%", height: 520, border: "none", display: "block" }}
                      sandbox="allow-same-origin"
                    />
                  </div>
                  {!pdfLinkInput && (
                    <div style={{ marginTop: 8, fontSize: 11, color: T.orange, fontWeight: 600 }}>
                      ⚠ Le bouton pointe vers [LIEN_DU_PDF] — renseigne le lien du PDF ci-dessus.
                    </div>
                  )}
                </div>
              )}

              {/* Texte */}
              {emailTab === "texte" && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: T.dim }}>Fallback texte brut (Gmail, Apple Mail…)</span>
                    <button type="button" onClick={() => copy(emailTexte, "texte")} style={copyBtn(copiedWhat === "texte")}>
                      {copiedWhat === "texte" ? "✓ Copié !" : "Copier le texte"}
                    </button>
                  </div>
                  <pre style={{ background: "#f8fafc", border: `1px solid ${T.border}`, borderRadius: 8, padding: "16px 18px", fontSize: 13, color: T.text, whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0, lineHeight: 1.8, userSelect: "all" }}>
                    {emailTexte}
                  </pre>
                  {!pdfLinkInput && (
                    <div style={{ marginTop: 8, fontSize: 11, color: T.orange, fontWeight: 600 }}>
                      ⚠ Renseigne le lien du PDF ci-dessus pour remplacer [LIEN_DU_PDF].
                    </div>
                  )}
                </div>
              )}

            </div>
          )}
        </div>

        {/* Tableau clients */}
        {customers.length === 0 ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "32px 24px", textAlign: "center", color: T.muted, fontSize: 14, boxShadow: T.shadow }}>
            Aucun client avec commande trouvé dans la boutique.
          </div>
        ) : (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: T.shadow }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f1f5f9" }}>
                    {["Client", "Email", "Commandes", "Total dépensé", "Langue", "Statut livret", "Action"].map((h) => (
                      <th
                        key={h}
                        style={{ padding: "11px 12px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap", borderBottom: `1px solid ${T.border}`, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c, i) => (
                    <ClientRow
                      key={c.id}
                      c={c}
                      livret={livretMap[c.id] as LivertEntry}
                      lang={detectLang(c)}
                      i={i}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
