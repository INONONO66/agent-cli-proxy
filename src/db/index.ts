import { initDb } from "./sqlite";
import { config } from "../config";
import { mkdirSync } from "fs";

if (config.dbPath !== ":memory:") {
  const dir = config.dbPath.split("/").slice(0, -1).join("/");
  if (dir) mkdirSync(dir, { recursive: true });
}

export const db = initDb(config.dbPath);
