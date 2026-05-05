import type { Database } from "bun:sqlite";
import { UsageRepo } from "../storage/repo";

export namespace Metrics {
  function escape(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }

  function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  export function render(db: Database): string {
    const today = todayUtc();
    const rows = UsageRepo.getDaily(db, today);

    const lines: string[] = [];

    lines.push("# HELP agent_cli_proxy_up Always 1 when the proxy is reachable");
    lines.push("# TYPE agent_cli_proxy_up gauge");
    lines.push("agent_cli_proxy_up 1");

    lines.push("# HELP agent_cli_proxy_requests_today Total proxied requests for the current UTC day, per provider/model");
    lines.push("# TYPE agent_cli_proxy_requests_today counter");

    lines.push("# HELP agent_cli_proxy_tokens_today Total tokens (prompt+completion+cache) for the current UTC day");
    lines.push("# TYPE agent_cli_proxy_tokens_today counter");

    lines.push("# HELP agent_cli_proxy_cost_usd_today Estimated cost in USD for the current UTC day, per provider/model");
    lines.push("# TYPE agent_cli_proxy_cost_usd_today counter");

    for (const row of rows) {
      const labels = `provider="${escape(row.provider)}",model="${escape(row.model)}"`;
      lines.push(`agent_cli_proxy_requests_today{${labels}} ${row.request_count}`);
      lines.push(`agent_cli_proxy_tokens_today{${labels}} ${row.total_tokens}`);
      const cost = Number.isFinite(row.cost_usd) ? row.cost_usd : 0;
      lines.push(`agent_cli_proxy_cost_usd_today{${labels}} ${cost}`);
    }

    return lines.join("\n") + "\n";
  }
}
