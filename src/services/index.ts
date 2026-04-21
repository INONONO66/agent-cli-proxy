import { db } from "../db/index";
import { createUsageService } from "./usageService";
import { startQuotaPoller } from "./quotaPoller";

export { db };
export const usageService = createUsageService(db);

// Start quota poller (reads GLM_API_KEY from env)
const glmApiKey = process.env.GLM_API_KEY ?? "";
startQuotaPoller(db, glmApiKey);
