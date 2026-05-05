import { UsageService } from "../storage/service";
import { AccountSubscriptionRepo } from "../storage/account-subscriptions";
import { RequestRepo } from "../storage/repo";
import { Plans } from "../plans";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "admin" });

export namespace Admin {
  export function createRouter(usageService: UsageService.UsageService) {
    return async function handleAdminRequest(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method !== "GET") return null;

      try {
        if (path === "/admin/usage/today") {
          return json(usageService.getToday());
        }

        if (path === "/admin/usage/range") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!from || !to)
            return json({ error: "Missing from or to parameter" }, 400);
          return json(usageService.getDateRange(from, to));
        }

        if (path === "/admin/usage/models") {
          const day =
            url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getModelBreakdown(day));
        }

        if (path === "/admin/usage/providers") {
          const day =
            url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getProviderBreakdown(day));
        }

        if (path === "/admin/usage/accounts") {
          const day =
            url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getAccountDaily(day));
        }

        if (path === "/admin/usage/accounts/range") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!from || !to)
            return json({ error: "Missing from or to parameter" }, 400);
          return json(usageService.getAccountRange(from, to));
        }

        if (path === "/admin/usage/accounts/summary") {
          const from =
            url.searchParams.get("from") ??
            new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
          const to =
            url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getAccountSummary(from, to));
        }

        if (path === "/admin/quotas" || path === "/admin/quotas/refresh") {
          const refresh = path.endsWith("/refresh") || url.searchParams.get("refresh") === "true";
          if (refresh) return json(await usageService.refreshQuotas());
          return json({ snapshots: usageService.getLatestQuotas() });
        }

        if (path === "/admin/plans") {
          const plans = Plans.list();
          logger.info("admin plans list", {
            event: "admin.plans.list",
            count: plans.length,
          });
          return json({ plans });
        }

        if (path === "/admin/plans/cost-summary") {
          const month = url.searchParams.get("month") ?? currentUtcMonth();
          const range = parseMonthRange(month);
          if (!range) {
            return json({
              error: {
                code: "INVALID_MONTH",
                message: "month must use YYYY-MM format",
              },
            }, 400);
          }

          const summary = buildCostSummary(usageService, month, range.start, range.end);
          logger.info("admin plans cost summary", {
            event: "admin.plans.cost_summary",
            month,
            accounts: summary.rows.length,
          });
          return json(summary);
        }

        const accountPlanMatch = path.match(/^\/admin\/plans\/account\/(.+)$/);
        if (accountPlanMatch) {
          const cliproxyAccount = decodeURIComponent(accountPlanMatch[1]);
          const accountView = buildAccountView(usageService, cliproxyAccount);
          if (!accountView) return json({ error: "Not found" }, 404);
          logger.info("admin plans account view", {
            event: "admin.plans.account_view",
            cliproxy_account: cliproxyAccount,
          });
          return json(accountView);
        }

        if (path === "/admin/stats") {
          return json(usageService.getTotalStats());
        }

        if (path === "/admin/logs") {
          const limit = Math.min(
            Number(url.searchParams.get("limit") ?? 50),
            200,
          );
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const tool = url.searchParams.get("tool");
          const clientId = url.searchParams.get("client_id");
          if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 1 || offset < 0)
            return json({ error: "Invalid limit or offset" }, 400);
          return json(
            usageService.getRecentLogs(
              limit,
              offset,
              tool ?? undefined,
              clientId ?? undefined,
            ),
          );
        }

        const logsMatch = path.match(/^\/admin\/logs\/(\d+)$/);
        if (logsMatch) {
          const id = Number(logsMatch[1]);
          const data = usageService.getLogById(id);
          if (!data) return json({ error: "Not found" }, 404);
          return json(data);
        }

        return null;
      } catch (err) {
        logger.error("admin request failed", { err, path, method: req.method });
        return json({ error: "Internal server error" }, 500);
      }
    };
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  interface MonthRange {
    start: string;
    end: string;
  }

  interface CostSummaryRow {
    cliproxy_account: string;
    subscription_code: string | null;
    monthly_price_usd: number;
    total_requests: number;
    total_cost_usd: number;
    computed_overage_usd: number;
  }

  interface CostSummary {
    month: string;
    rows: CostSummaryRow[];
    totals: {
      accounts: number;
      total_requests: number;
      total_cost_usd: number;
      total_monthly_price_usd: number;
      total_overage_usd: number;
    };
  }

  interface AccountPlanView {
    cliproxy_account: string;
    subscription_code: string | null;
    monthly_price_usd: number;
    bound_at: string | null;
    recent_usage: RequestRepo.AccountRecentUsage[];
  }

  function currentUtcMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }

  function parseMonthRange(month: string): MonthRange | null {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) return null;

    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    return {
      start: new Date(Date.UTC(year, monthIndex, 1)).toISOString(),
      end: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString(),
    };
  }

  /**
   * Builds the monthly monitoring summary from completed request logs.
   * Accounts with usage but no account_subscriptions binding are included with
   * subscription_code=null, monthly_price_usd=0, and overage equal to total cost
   * so unbound spend remains visible to operators.
   */
  function buildCostSummary(
    usageService: UsageService.UsageService,
    month: string,
    monthStart: string,
    monthEnd: string,
  ): CostSummary {
    const rows = RequestRepo.aggregateByAccountForMonth(
      usageService.db,
      monthStart,
      monthEnd,
    ).map((row): CostSummaryRow => {
      const monthlyPriceUsd = row.subscription_code
        ? Plans.byCode(row.subscription_code)?.monthly_price_usd ?? 0
        : 0;
      const computedOverageUsd = Math.max(row.total_cost_usd - monthlyPriceUsd, 0);
      return {
        cliproxy_account: row.cliproxy_account,
        subscription_code: row.subscription_code,
        monthly_price_usd: monthlyPriceUsd,
        total_requests: row.total_requests,
        total_cost_usd: row.total_cost_usd,
        computed_overage_usd: computedOverageUsd,
      };
    });

    const totals = rows.reduce(
      (acc, row) => ({
        accounts: acc.accounts + 1,
        total_requests: acc.total_requests + row.total_requests,
        total_cost_usd: acc.total_cost_usd + row.total_cost_usd,
        total_monthly_price_usd: acc.total_monthly_price_usd + row.monthly_price_usd,
        total_overage_usd: acc.total_overage_usd + row.computed_overage_usd,
      }),
      {
        accounts: 0,
        total_requests: 0,
        total_cost_usd: 0,
        total_monthly_price_usd: 0,
        total_overage_usd: 0,
      },
    );

    return { month, rows, totals };
  }

  function buildAccountView(
    usageService: UsageService.UsageService,
    cliproxyAccount: string,
  ): AccountPlanView | null {
    const binding = AccountSubscriptionRepo.get(usageService.db, cliproxyAccount);
    const recentUsage = RequestRepo.getRecentByAccount(usageService.db, cliproxyAccount, 50);
    if (!binding && recentUsage.length === 0) return null;

    const monthlyPriceUsd = binding
      ? Plans.byCode(binding.subscription_code)?.monthly_price_usd ?? 0
      : 0;

    return {
      cliproxy_account: cliproxyAccount,
      subscription_code: binding?.subscription_code ?? null,
      monthly_price_usd: monthlyPriceUsd,
      bound_at: binding?.bound_at ?? null,
      recent_usage: recentUsage,
    };
  }
}
