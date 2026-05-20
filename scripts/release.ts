#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type BumpType = "patch" | "minor" | "major";

interface Commit {
  hash: string;
  type: string;
  scope: string;
  description: string;
  breaking: boolean;
}

const packageJsonPath = resolve(import.meta.dir, "..", "package.json");
const changelogPath = resolve(import.meta.dir, "..", "CHANGELOG.md");

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  return pkg.version;
}

function writePackageVersion(version: string): void {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  pkg.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function bumpVersion(current: string, bump: BumpType): string {
  const [major, minor, patch] = current.split(".").map(Number);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

async function gitExec(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: resolve(import.meta.dir, ".."),
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
  }
  return out.trim();
}

function getLastTag(): string | null {
  try {
    const tag = Bun.spawnSync(["git", "describe", "--tags", "--abbrev=0"], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tag.exitCode !== 0) return null;
    return new TextDecoder().decode(tag.stdout).trim() || null;
  } catch {
    return null;
  }
}

function parseCommitLine(line: string): Commit | null {
  const match = /^([a-f0-9]+)\s+(.*)$/.exec(line);
  if (!match) return null;
  const [, hash, message] = match;

  const conventional = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(message);
  if (!conventional) return null;
  const [, type, scope = "", bang, description] = conventional;

  return {
    hash,
    type,
    scope,
    description,
    breaking: bang === "!",
  };
}

async function getCommitsSinceTag(tag: string | null): Promise<Commit[]> {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const log = await gitExec(["log", range, "--oneline", "--no-decorate"]);
  if (!log) return [];

  return log
    .split("\n")
    .map(parseCommitLine)
    .filter((c): c is Commit => c !== null);
}

function inferBump(commits: Commit[]): BumpType {
  if (commits.some((c) => c.breaking)) return "major";
  if (commits.some((c) => c.type === "feat")) return "minor";
  return "patch";
}

function groupCommits(commits: Commit[]): Map<string, Commit[]> {
  const order = ["feat", "fix", "perf", "refactor", "test", "docs", "chore", "build", "ci"];
  const groups = new Map<string, Commit[]>();
  for (const type of order) groups.set(type, []);

  for (const commit of commits) {
    const key = order.includes(commit.type) ? commit.type : "chore";
    groups.get(key)!.push(commit);
  }

  for (const [key, value] of groups) {
    if (value.length === 0) groups.delete(key);
  }
  return groups;
}

const typeLabels: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactors",
  test: "Tests",
  docs: "Documentation",
  chore: "Chores",
  build: "Build",
  ci: "CI",
};

function formatChangelog(version: string, previousVersion: string, date: string, commits: Commit[]): string {
  const groups = groupCommits(commits);
  const lines: string[] = [`## [${version}](https://github.com/INONONO66/agent-cli-proxy/compare/v${previousVersion}...v${version}) (${date})`, ""];

  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length > 0) {
    lines.push("### BREAKING CHANGES", "");
    for (const c of breaking) {
      const scope = c.scope ? `**${c.scope}:** ` : "";
      lines.push(`- ${scope}${c.description} (${c.hash.slice(0, 7)})`);
    }
    lines.push("");
  }

  for (const [type, grouped] of groups) {
    const label = typeLabels[type] ?? type;
    lines.push(`### ${label}`, "");
    for (const c of grouped) {
      const scope = c.scope ? `**${c.scope}:** ` : "";
      lines.push(`- ${scope}${c.description} (${c.hash.slice(0, 7)})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function prependChangelog(entry: string): void {
  let existing = "";
  try {
    existing = readFileSync(changelogPath, "utf-8");
  } catch {
    // first release — no existing file
  }

  const header = "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";
  const body = existing.replace(/^# Changelog\n+.*documented in this file\.\n*/s, "");
  writeFileSync(changelogPath, `${header}${entry}${body}`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const explicitBump = args[0] as BumpType | undefined;
  const dryRun = args.includes("--dry-run");

  if (explicitBump && !["patch", "minor", "major"].includes(explicitBump)) {
    console.error(`Usage: bun run scripts/release.ts [patch|minor|major] [--dry-run]`);
    process.exit(1);
  }

  const status = await gitExec(["status", "--porcelain"]);
  if (status) {
    console.error("Working tree is dirty. Commit or stash changes first.");
    process.exit(1);
  }

  const branch = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") {
    console.error(`Release must run on main branch (currently on ${branch}).`);
    process.exit(1);
  }

  const lastTag = getLastTag();
  const commits = await getCommitsSinceTag(lastTag);

  if (commits.length === 0) {
    console.error("No conventional commits since last tag. Nothing to release.");
    process.exit(1);
  }

  const bump = explicitBump ?? inferBump(commits);
  const currentVersion = readPackageVersion();
  const nextVersion = bumpVersion(currentVersion, bump);
  const date = today();

  console.log(`${currentVersion} → ${nextVersion} (${bump})`);
  console.log(`${commits.length} commits since ${lastTag ?? "initial"}`);

  const entry = formatChangelog(nextVersion, currentVersion, date, commits);

  if (dryRun) {
    console.log("\n--- CHANGELOG ENTRY (dry-run) ---\n");
    console.log(entry);
    return;
  }

  console.log("Running release-check...");
  const check = Bun.spawnSync(["bun", "run", "release-check"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (check.exitCode !== 0) {
    console.error("release-check failed. Fix issues before releasing.");
    process.exit(1);
  }

  prependChangelog(entry);
  console.log("Updated CHANGELOG.md");

  writePackageVersion(nextVersion);
  console.log(`Bumped package.json to ${nextVersion}`);

  await gitExec(["add", "package.json", "CHANGELOG.md"]);
  await gitExec(["commit", "-m", `chore(release): ${nextVersion}`]);
  console.log(`Committed: chore(release): ${nextVersion}`);

  await gitExec(["tag", "-a", `v${nextVersion}`, "-m", `v${nextVersion}`]);
  console.log(`Tagged: v${nextVersion}`);

  console.log(`\nDone. To publish:\n  git push origin main --follow-tags`);
}

run();
