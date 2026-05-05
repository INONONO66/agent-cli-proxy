import { Config } from "../src/config";
import { Storage } from "../src/storage/db";
import { UsageService } from "../src/storage/service";

function parseLimit(): number | undefined {
  const arg = process.argv.find((value) => value.startsWith("--limit="));
  if (!arg) return undefined;
  const value = Number(arg.slice("--limit=".length));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const db = Storage.initDb(Config.dbPath);
const usageService = UsageService.create(db);

const result = await usageService.backfillCosts({
  all: process.argv.includes("--all"),
  limit: parseLimit(),
});

console.log(`[backfill-costs] scanned=${result.scanned} updated=${result.updated} ok=${result.ok} pending=${result.pending} unsupported=${result.unsupported}`);
db.close();
