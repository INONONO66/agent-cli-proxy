import { Logger } from "../util/logger";
import { Config as ConfigValidator } from "./validate";

export { ConfigError } from "./validate";
export type { ConfigIssue, EnvLike, ValidatedConfig, ValidateOptions } from "./validate";

const configLogger = Logger.fromConfig().child({ component: "config" });
const validated = ConfigValidator.validate(process.env, {
  onWarning(issue) {
    configLogger.warn("configuration warning", { event: "config.warning", ...issue });
  },
});

export const Config = Object.freeze({
  ...validated,
  validate: ConfigValidator.validate,
});
