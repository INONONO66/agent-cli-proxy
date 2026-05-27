import React, { useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthContext, AuthProvider, Layout } from "./components/Layout";
import { LoginForm } from "./components/LoginForm";
import { QuotasPage } from "./pages/QuotasPage";
import { LogsPage } from "./pages/LogsPage";
import { UsagePage } from "./pages/UsagePage";
import { OAuthPage } from "./pages/OAuthPage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import "./styles.css";

function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash || "#/quotas");

  useEffect(() => {
    function onHashChange() {
      setRoute(window.location.hash || "#/quotas");
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

function Router() {
  const route = useRoute();
  const { authenticated, loading } = useContext(AuthContext);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Card className="w-full max-w-sm p-6">
          <Skeleton className="h-4 w-3/5 mb-3" />
          <Skeleton className="h-3 w-full" />
        </Card>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginForm />;
  }

  const page = route.replace("#", "").split("/")[1] || "quotas";

  let content: React.ReactNode;
  switch (page) {
    case "quotas":
      content = <QuotasPage />;
      break;
    case "logs":
      content = <LogsPage />;
      break;
    case "usage":
      content = <UsagePage />;
      break;
    case "oauth":
      content = <OAuthPage />;
      break;
    case "api-keys":
      content = <ApiKeysPage />;
      break;
    default:
      content = <QuotasPage />;
  }

  return <Layout>{content}</Layout>;
}

function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
