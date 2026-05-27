import type { Usage } from "../../usage";
import { Num } from "../utils/numbers";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

interface UsageSummaryProps {
  summary: Usage.DailyUsageSummary;
}

export function UsageSummary({ summary }: UsageSummaryProps) {
  const maxTokens = Math.max(
    1,
    ...summary.breakdown.map((b) => b.total_tokens),
  );

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Requests</div>
            <div className="text-2xl font-bold"><Num value={summary.requests} /></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Total Tokens</div>
            <div className="text-2xl font-bold"><Num value={summary.total_tokens} /></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Cost</div>
            <div className="text-2xl font-bold"><Num value={summary.cost_usd} format="cost" /></div>
          </CardContent>
        </Card>
      </div>

      {summary.breakdown.length > 0 && (
        <Card>
          <CardContent>
            <h4 className="text-sm font-medium text-muted-foreground mb-3">
              Model Breakdown
            </h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="w-[140px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.breakdown.map((row) => (
                  <TableRow key={`${row.provider}-${row.model}`}>
                    <TableCell><span className="font-mono">{row.model}</span></TableCell>
                    <TableCell>{row.provider}</TableCell>
                    <TableCell className="text-right"><Num value={row.request_count} /></TableCell>
                    <TableCell className="text-right"><Num value={row.total_tokens} /></TableCell>
                    <TableCell className="text-right"><Num value={row.cost_usd} format="cost" /></TableCell>
                    <TableCell>
                      <div className="flex items-center h-5">
                        <div className="w-full h-1.5 rounded-full bg-primary/20 overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all"
                            style={{ width: `${(row.total_tokens / maxTokens) * 100}%` }}
                          />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
