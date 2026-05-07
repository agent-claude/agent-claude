import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  console.log("APP.TSX LOADER HIT:", url.pathname + url.search);
  console.log("  headers.authorization:", request.headers.get("authorization") ? "PRESENT (Bearer ...)" : "ABSENT");
  console.log("  headers.x-shopify-bounce:", request.headers.get("X-Shopify-Bounce") ?? "absent");
  console.log("  embedded:", url.searchParams.get("embedded"));
  console.log("  id_token:", url.searchParams.get("id_token") ? "PRESENT" : "absent");
  await authenticate.admin(request);
  console.log("APP.TSX LOADER AUTH OK");
  return { apiKey: process.env.SHOPIFY_API_KEY ?? "" };
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function AppLayout() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <a href="/app" rel="home">Dashboard</a>
        <a href="/app/ugc">UGC</a>
        <a href="/app/todo">To Do List</a>
        <a href="/app/recettes">Livret Recettes</a>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}
