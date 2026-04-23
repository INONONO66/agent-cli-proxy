import React, { useState } from "react";
import { api, HealthResponse } from "../lib/api";
import { useFetch, useInterval } from "../lib/hooks";

interface ServiceDef {
  key: string;
  name: string;
  description: string;
}

const SERVICES: ServiceDef[] = [
  { key: "proxy", name: "Proxy", description: "agent-cli-proxy server" },
  { key: "prometheus", name: "Prometheus", description: "Metrics collection" },
  { key: "loki", name: "Loki", description: "Log aggregation" },
  { key: "node_exporter", name: "Node Exporter", description: "Host metrics" },
];

interface ServiceCardProps {
  service: ServiceDef;
  status: "up" | "down" | "unknown";
  checkedAt: string;
}

function ServiceCard({ service, status, checkedAt }: ServiceCardProps) {
  const isUp = status === "up";
  const isUnknown = status === "unknown";

  return (
    <div className={`health-card ${isUnknown ? "" : status}`}>
      <div className={`health-indicator ${isUnknown ? "down" : status}`} />
      <div className="health-info">
        <div className="health-name">{service.name}</div>
        <div className={`health-status ${isUnknown ? "down" : status}`}>
          {isUnknown ? "Unknown" : isUp ? "Operational" : "Down"}
        </div>
        <div className="health-time">{service.description}</div>
        <div className="health-time">Checked: {checkedAt}</div>
      </div>
    </div>
  );
}

function formatCheckedAt(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function HealthPage() {
  const [checkedAt, setCheckedAt] = useState(new Date());

  const { data, loading, error, refetch } = useFetch<HealthResponse>(
    () => api.health.check().then((res) => {
      setCheckedAt(new Date());
      return res;
    }),
    []
  );

  useInterval(() => {
    refetch();
  }, 15_000);

  const services = data?.services ?? {};

  const allUp = SERVICES.every((s) => services[s.key] === "up");
  const anyDown = SERVICES.some((s) => services[s.key] === "down");

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 className="page-title">Health</h1>
            <p className="page-subtitle">Service status and availability</p>
          </div>
          <div className="refresh-indicator">
            <div className="refresh-dot" />
            Auto-refresh 15s
          </div>
        </div>
      </div>

      {error && <div className="error-state">{error}</div>}

      {!loading && !error && data && (
        <div
          className="card"
          style={{
            marginBottom: "var(--space-5)",
            borderColor: allUp
              ? "rgba(63, 185, 80, 0.4)"
              : anyDown
              ? "rgba(248, 81, 73, 0.4)"
              : "var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: allUp
                  ? "var(--accent-green)"
                  : anyDown
                  ? "var(--accent-red)"
                  : "var(--accent-yellow)",
              }}
            />
            <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
              {allUp
                ? "All systems operational"
                : anyDown
                ? "One or more services are down"
                : "Some services have unknown status"}
            </span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-spinner">
          <div className="spinner" />
          <span>Checking services...</span>
        </div>
      ) : (
        <div className="health-grid">
          {SERVICES.map((service) => (
            <ServiceCard
              key={service.key}
              service={service}
              status={(services[service.key] as "up" | "down") ?? "unknown"}
              checkedAt={formatCheckedAt(checkedAt)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
