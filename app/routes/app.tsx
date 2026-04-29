import { NavMenu } from "@shopify/app-bridge-react";
import { Outlet } from "react-router";

export default function AppLayout() {
  return (
    <>
      <NavMenu>
        <a href="/app" rel="home">Dashboard</a>
        <a href="/app/ugc">UGC</a>
      </NavMenu>
      <Outlet />
    </>
  );
}
