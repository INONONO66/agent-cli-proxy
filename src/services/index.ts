import { db } from "../db/index";
import { createUsageService } from "./usageService";

export const usageService = createUsageService(db);
