import { useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const todos = await prisma.todo.findMany({ orderBy: [{ done: "asc" }, { createdAt: "desc" }] });
  return { todos };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form   = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "create") {
    const title = (form.get("title") as string).trim();
    if (title) await prisma.todo.create({ data: { title } });
    return null;
  }

  if (intent === "toggle") {
    const id   = form.get("id") as string;
    const done = form.get("done") === "true";
    await prisma.todo.update({ where: { id }, data: { done: !done } });
    return null;
  }

  if (intent === "delete") {
    await prisma.todo.delete({ where: { id: form.get("id") as string } });
    return null;
  }

  return null;
};

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", dim: "#94a3b8", accent: "#6366f1",
  green: "#059669", greenBg: "#f0fdf4",
  red: "#dc2626",
  shadow: "0 1px 3px rgba(0,0,0,0.07)",
} as const;

// ─── Composant tâche ─────────────────────────────────────────────────────────

function TodoItem({ todo }: { todo: { id: string; title: string; done: boolean } }) {
  const fetcher = useFetcher();
  const optimisticDone = fetcher.formData
    ? fetcher.formData.get("intent") === "toggle"
      ? !todo.done
      : todo.done
    : todo.done;
  const isDeleting = fetcher.formData?.get("intent") === "delete";

  if (isDeleting) return null;

  return (
    <li style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "12px 16px",
      borderBottom: `1px solid ${T.border}`,
      background: optimisticDone ? "#f8fafc" : T.card,
      transition: "background 0.15s",
    }}>
      {/* Checkbox toggle */}
      <fetcher.Form method="post" style={{ display: "contents" }}>
        <input type="hidden" name="intent" value="toggle" />
        <input type="hidden" name="id" value={todo.id} />
        <input type="hidden" name="done" value={String(todo.done)} />
        <button type="submit" style={{
          width: 20, height: 20, borderRadius: 6, flexShrink: 0, cursor: "pointer",
          border: optimisticDone ? "none" : `2px solid ${T.border}`,
          background: optimisticDone ? T.green : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 0, transition: "all 0.15s",
        }}>
          {optimisticDone && (
            <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
              <path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </fetcher.Form>

      {/* Titre */}
      <span style={{
        flex: 1, fontSize: 14, color: optimisticDone ? T.muted : T.text,
        textDecoration: optimisticDone ? "line-through" : "none",
        wordBreak: "break-word",
      }}>
        {todo.title}
      </span>

      {/* Supprimer */}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="id" value={todo.id} />
        <button type="submit" style={{
          background: "none", border: "none", cursor: "pointer",
          color: T.dim, fontSize: 16, padding: "2px 4px", lineHeight: 1,
          borderRadius: 4, flexShrink: 0,
        }}
          onMouseEnter={e => (e.currentTarget.style.color = T.red)}
          onMouseLeave={e => (e.currentTarget.style.color = T.dim)}
        >
          ✕
        </button>
      </fetcher.Form>
    </li>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TodoPage() {
  const { todos } = useLoaderData<typeof loader>();
  const fetcher   = useFetcher();
  const inputRef  = useRef<HTMLInputElement>(null);
  const isAdding  = fetcher.state === "submitting";

  const pending = todos.filter(t => !t.done);
  const done    = todos.filter(t => t.done);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const form  = e.currentTarget;
    const input = form.querySelector<HTMLInputElement>("[name=title]");
    if (!input?.value.trim()) { e.preventDefault(); return; }
    setTimeout(() => { if (inputRef.current) inputRef.current.value = ""; }, 0);
  }

  return (
    <div style={{
      minHeight: "100vh", background: T.bg, padding: "32px 24px 60px",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxSizing: "border-box",
    }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: T.text }}>To Do List</h1>
            <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>
              {pending.length} tâche{pending.length !== 1 ? "s" : ""} en cours
              {done.length > 0 && ` · ${done.length} terminée${done.length !== 1 ? "s" : ""}`}
            </p>
          </div>
          <a href="/app" style={{
            fontSize: 12, color: T.accent, textDecoration: "none",
            border: "1px solid #c7d2fe", padding: "4px 12px", borderRadius: 8,
          }}>← Dashboard</a>
        </div>

        {/* Formulaire ajout */}
        <fetcher.Form method="post" onSubmit={handleSubmit} style={{ marginBottom: 24 }}>
          <input type="hidden" name="intent" value="create" />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              ref={inputRef}
              name="title"
              placeholder="Nouvelle tâche…"
              autoComplete="off"
              style={{
                flex: 1, border: `1px solid ${T.border}`, borderRadius: 10,
                padding: "10px 14px", fontSize: 14, background: T.card,
                boxSizing: "border-box", outline: "none",
                boxShadow: T.shadow,
              }}
            />
            <button type="submit" disabled={isAdding} style={{
              background: T.accent, color: "#fff", border: "none", borderRadius: 10,
              padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer",
              opacity: isAdding ? 0.7 : 1, whiteSpace: "nowrap",
            }}>
              {isAdding ? "…" : "+ Ajouter"}
            </button>
          </div>
        </fetcher.Form>

        {/* Liste tâches en cours */}
        {pending.length > 0 && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden", boxShadow: T.shadow, marginBottom: 16 }}>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {pending.map(t => <TodoItem key={t.id} todo={t} />)}
            </ul>
          </div>
        )}

        {todos.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 24px", color: T.dim, fontSize: 14 }}>
            Aucune tâche pour l'instant — ajoute-en une !
          </div>
        )}

        {/* Tâches terminées */}
        {done.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: T.dim, letterSpacing: "0.08em", marginBottom: 8 }}>
              Terminées ({done.length})
            </div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden", boxShadow: T.shadow }}>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {done.map(t => <TodoItem key={t.id} todo={t} />)}
              </ul>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
