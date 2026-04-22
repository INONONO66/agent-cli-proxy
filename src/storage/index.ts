import { mkdirSync } from "fs";
import { dirname } from "path";
import { Config } from "../config";
import { Storage } from "./db";
import { UsageService } from "./service";

mkdirSync(dirname(Config.dbPath), { recursive: true });
const db = Storage.initDb(Config.dbPath);
export const usageService = UsageService.create(db);
