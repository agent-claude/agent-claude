import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  console.log("APP.TSX LOADER HIT:", url.pathname);
  console.log("  auth:", request.headers.get("authorization") ? "PRESENT" : "ABSENT");
  console.log("  bounce:", request.headers.get("X-Shopify-Bounce") ?? "absent");
  console.log("  embedded:", url.searchParams.get("embedded"));
  console.log("  id_token:", url.searchParams.get("id_token") ? "PRESENT" : "absent");
  await authenticate.admin(request);
  console.log("APP.TSX AUTH OK");
  return { ok: true };
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function AppLayout() {
  return <Outlet />;
}
