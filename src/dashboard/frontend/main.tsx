import React from "react";
import { createRoot } from "react-dom/client";
import { useAuth } from "./lib/auth";
import { useHashRoute } from "./lib/hooks";
import { Layout } from "./components/Layout";
import { LoginPage } from "./components/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { LogsPage } from "./pages/LogsPage";
import { MetricsPage } from "./pages/MetricsPage";
import { HealthPage } from "./pages/HealthPage";

function App() {
  const auth = useAuth();
  const route = useHashRoute();

  if (auth.loading) {
    return (
      <div className="loading-spinner" style={{ height: "100vh" }}>
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return <LoginPage onLogin={auth.login} />;
  }

  const page = resolveRoute(route);

  return (
    <Layout route={route} username={auth.username} onLogout={auth.logout}>
      {page}
    </Layout>
  );
}

function resolveRoute(route: string): React.ReactElement {
  if (route === "/" || route === "") return <OverviewPage />;
  if (route === "/logs") return <LogsPage />;
  if (route === "/metrics") return <MetricsPage />;
  if (route === "/health") return <HealthPage />;
  return (
    <div className="empty-state">
      <div className="empty-state-icon">⚠️</div>
      <div className="empty-state-text">Page not found: {route}</div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
