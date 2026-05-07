
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  console.log("AUTH.$ LOADER HIT:", url.pathname + url.search.slice(0, 120));
  console.log("  auth header:", request.headers.get("authorization") ? "PRESENT" : "ABSENT");
  console.log("  X-Shopify-Bounce:", request.headers.get("X-Shopify-Bounce") ?? "absent");
  await authenticate.admin(request);
  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
