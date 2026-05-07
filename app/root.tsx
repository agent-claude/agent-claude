import type { LoaderFunctionArgs } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("ROOT LOADER HIT:", request.url);
  return { apiKey: process.env.SHOPIFY_API_KEY ?? "" };
};

export default function App() {
  const data = useLoaderData<typeof loader>();
  const apiKey = data?.apiKey ?? "";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {apiKey && <meta name="shopify-api-key" content={apiKey} />}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <div style={{ position: "fixed", top: 0, left: 0, zIndex: 999999, background: "red", color: "white", padding: "10px", fontSize: 14, fontWeight: "bold", pointerEvents: "none" }}>
          ROOT OK — apiKey: {apiKey ? apiKey.slice(0, 8) + "…" : "MISSING"}
        </div>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
