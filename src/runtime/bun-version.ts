export const MIN_BUN_VERSION = "1.3.0";

const MIN_BUN_VERSION_PARTS = [1, 3, 0] as const;

type BunVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

export class UnsupportedBunVersionError extends Error {
  readonly currentVersion: string;
  readonly minimumVersion: string;

  constructor(currentVersion: string) {
    super(`Bun ${MIN_BUN_VERSION} or newer is required; current version is ${currentVersion}`);
    this.name = "UnsupportedBunVersionError";
    this.currentVersion = currentVersion;
    this.minimumVersion = MIN_BUN_VERSION;
  }
}

export function assertSupportedBunVersion(version: string): void {
  if (isSupportedBunVersion(version)) return;
  throw new UnsupportedBunVersionError(version);
}

export function isSupportedBunVersion(version: string): boolean {
  const parsed = parseBunVersion(version);
  if (!parsed) return false;
  const [major, minor, patch] = MIN_BUN_VERSION_PARTS;
  if (parsed.major !== major) return parsed.major > major;
  if (parsed.minor !== minor) return parsed.minor > minor;
  return parsed.patch >= patch;
}

function parseBunVersion(version: string): BunVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  const [, majorText, minorText, patchText] = match;
  if (majorText === undefined || minorText === undefined || patchText === undefined) return null;
  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);
  const patch = Number.parseInt(patchText, 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}
