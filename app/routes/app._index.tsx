import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  console.log("APP._INDEX LOADER HIT:", url.pathname);
  console.log("  auth:", request.headers.get("authorization") ? "PRESENT" : "ABSENT");
  console.log("  bounce:", request.headers.get("X-Shopify-Bounce") ?? "absent");
  await authenticate.admin(request);
  console.log("APP._INDEX AUTH OK");
  return { ts: Date.now() };
};

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  return (
    <div style={{
      padding: 40,
      fontSize: 24,
      fontWeight: "bold",
      color: "#000",
      background: "#fff",
      minHeight: "100vh",
    }}>
      AGENT CLAUDE CONNECTÉ ✓ ({d.ts})
    </div>
  );
}
