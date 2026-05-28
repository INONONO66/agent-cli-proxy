import React, { useContext } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client";
import { AuthContext, AuthProvider, Layout } from "./components/Layout";
import { LoginForm } from "./components/LoginForm";
import { useRoute } from "./hooks/useRoute";
import { QuotasPage } from "./pages/QuotasPage";
import { LogsPage } from "./pages/LogsPage";
import { UsagePage } from "./pages/UsagePage";
import { OAuthPage } from "./pages/OAuthPage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SystemPage } from "./pages/SystemPage";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import "./styles.css";

function Router() {
  const { page } = useRoute();
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

  let content: React.ReactNode;
  switch (page) {
    case "overview":
      content = <OverviewPage />;
      break;
    case "quotas":
      content = <QuotasPage />;
      break;
    case "usage":
      content = <UsagePage />;
      break;
    case "logs":
      content = <LogsPage />;
      break;
    case "api-keys":
      content = <ApiKeysPage />;
      break;
    case "oauth":
      content = <OAuthPage />;
      break;
    case "system":
      content = <SystemPage />;
      break;
    default:
      content = <OverviewPage />;
  }

  return <Layout>{content}</Layout>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router />
      </AuthProvider>
    </QueryClientProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
