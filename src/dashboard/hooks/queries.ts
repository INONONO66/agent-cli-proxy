import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getTodayUsage,
  getUsageRange,
  getModelBreakdown,
  getProviderBreakdown,
  getAccountSummary,
  getStats,
  fetchUsageTrend,
  getLogs,
  getLogById,
  getCostAudit,
  getQuotas,
  refreshQuotasDetail,
  getBreakers,
  resetBreaker,
  getProviders,
  getPricing,
  getConfig,
  getQuotaProbes,
  getHealth,
  getReady,
  fetchApiKeys,
  fetchApiKeyUsage,
  getOAuthAccounts,
  getAccountUsage,
  getAccountUsageRange,
  fetchQuotaHistory,
  type LogQuery,
} from "../api";

export function useQuotas() {
  return useQuery({ queryKey: ["quotas"], queryFn: () => getQuotas(), refetchInterval: 30_000 });
}

export function useQuotaRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshQuotasDetail,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["quotas"] }); },
  });
}

export function useQuotaHistory(hours?: number, from?: string, to?: string) {
  return useQuery({
    queryKey: ["quotas", "history", hours, from, to],
    queryFn: () => fetchQuotaHistory(hours, from, to),
    refetchInterval: 60_000,
  });
}

export function useQuotaProbes() {
  return useQuery({ queryKey: ["quotas", "probes"], queryFn: getQuotaProbes, staleTime: 300_000 });
}

export function useTodayUsage() {
  return useQuery({ queryKey: ["usage", "today"], queryFn: getTodayUsage, refetchInterval: 30_000 });
}

export function useUsageRange(from: string, to: string) {
  return useQuery({
    queryKey: ["usage", "range", from, to],
    queryFn: () => getUsageRange(from, to),
    refetchInterval: 30_000,
  });
}

export function useModelBreakdown(from?: string, to?: string) {
  return useQuery({
    queryKey: ["usage", "models", from, to],
    queryFn: () => getModelBreakdown(undefined, from, to),
    refetchInterval: 30_000,
  });
}

export function useProviderBreakdown(from?: string, to?: string) {
  return useQuery({
    queryKey: ["usage", "providers", from, to],
    queryFn: () => getProviderBreakdown(undefined, from, to),
    refetchInterval: 30_000,
  });
}

export function useAccountSummary(from?: string, to?: string) {
  return useQuery({
    queryKey: ["usage", "accounts", "summary", from, to],
    queryFn: () => getAccountSummary(from, to),
    refetchInterval: 30_000,
  });
}

export function useAccountUsage(day?: string) {
  return useQuery({
    queryKey: ["usage", "accounts", day],
    queryFn: () => getAccountUsage(day),
    refetchInterval: 30_000,
  });
}

export function useAccountUsageRange(from: string, to: string) {
  return useQuery({
    queryKey: ["usage", "accounts", "range", from, to],
    queryFn: () => getAccountUsageRange(from, to),
    refetchInterval: 30_000,
  });
}

export function useUsageTrend(hours?: number, from?: string, to?: string) {
  return useQuery({
    queryKey: ["usage", "trend", hours, from, to],
    queryFn: () => fetchUsageTrend(hours, from, to),
    refetchInterval: 30_000,
  });
}

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: getStats, refetchInterval: 60_000 });
}

export function useLogs(query: LogQuery) {
  return useQuery({
    queryKey: ["logs", query],
    queryFn: () => getLogs(query),
    refetchInterval: 10_000,
  });
}

export function useLogDetail(id: number | null) {
  return useQuery({
    queryKey: ["logs", "detail", id],
    queryFn: () => getLogById(id!),
    enabled: id !== null,
  });
}

export function useCostAudit(requestLogId: number | null) {
  return useQuery({
    queryKey: ["logs", "cost-audit", requestLogId],
    queryFn: () => getCostAudit(requestLogId!),
    enabled: requestLogId !== null,
  });
}

export function useBreakers() {
  return useQuery({ queryKey: ["breakers"], queryFn: getBreakers, refetchInterval: 30_000 });
}

export function useBreakerReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: resetBreaker,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["breakers"] }); },
  });
}

export function useProviders() {
  return useQuery({ queryKey: ["providers"], queryFn: getProviders, staleTime: 300_000 });
}

export function usePricing() {
  return useQuery({ queryKey: ["pricing"], queryFn: getPricing, staleTime: 60_000 });
}

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: getConfig, staleTime: 300_000 });
}

export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval: 30_000 });
}

export function useReady() {
  return useQuery({ queryKey: ["ready"], queryFn: getReady, refetchInterval: 30_000 });
}

export function useApiKeys() {
  return useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys, refetchInterval: 30_000 });
}

export function useApiKeyUsage(id: number | null) {
  return useQuery({
    queryKey: ["api-keys", "usage", id],
    queryFn: () => fetchApiKeyUsage(id!),
    enabled: id !== null,
  });
}

export function useOAuthAccounts() {
  return useQuery({ queryKey: ["oauth", "accounts"], queryFn: getOAuthAccounts, refetchInterval: 30_000 });
}
