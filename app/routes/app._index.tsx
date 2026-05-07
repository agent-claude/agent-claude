import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("APP._INDEX LOADER HIT:", request.url);
  await authenticate.admin(request);
  console.log("APP._INDEX LOADER AUTH OK");
  return { ok: true };
};

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  return (
    <div style={{ padding: 40, fontSize: 32, color: "black", background: "white" }}>
      APP ROUTE OK — loader: {String(d.ok)}
    </div>
  );
}
