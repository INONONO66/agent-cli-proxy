export function formatCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatCostCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (Math.abs(n) >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function Num({
  value,
  format = "number",
}: {
  value: number;
  format?: "number" | "cost" | "tokens";
}) {
  const compact = format === "cost" ? formatCostCompact(value) : formatCompact(value);
  const exact = format === "cost" ? `$${value.toFixed(4)}` : value.toLocaleString();
  return <span className="mono" title={exact}>{compact}</span>;
}
