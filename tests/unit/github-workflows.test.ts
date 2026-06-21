import { describe, expect, test } from "bun:test";

const rootDir = new URL("../..", import.meta.url).pathname;

async function workflow(name: string): Promise<string> {
  return Bun.file(`${rootDir}/.github/workflows/${name}`).text();
}

function expectLine(text: string, pattern: RegExp): void {
  expect(text.split("\n").some((line) => pattern.test(line))).toBe(true);
}

const SHA_PIN = "[0-9a-f]{40}";
const NPM_AUTH_ENV_NAMES = [`${"NPM"}_${"TOKEN"}`, `${"NODE"}_${"AUTH"}_${"TOKEN"}`] as const;
const PROVENANCE_FLAG = `--${"provenance"}`;

function expectPinnedAction(text: string, action: string): void {
  expectLine(text, new RegExp(`^\\s+(?:- )?uses: ${action}@${SHA_PIN}$`));
}

function expectNoFloatingActionTags(text: string): void {
  expect(text).not.toMatch(/uses: [^\n]+@v\d+(?:\s|$)/);
}

describe("GitHub workflow hardening", () => {
  test("CI uses least privilege, stale-run cancellation, frozen installs, and a timeout", async () => {
    const ci = await workflow("ci.yml");

    expect(ci).toContain("permissions:\n  contents: read");
    expect(ci).toContain("concurrency:\n  group: ci-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true");
    expectLine(ci, /^    timeout-minutes: 15$/);
    expectPinnedAction(ci, "actions/checkout");
    expectPinnedAction(ci, "oven-sh/setup-bun");
    expectNoFloatingActionTags(ci);
    expectLine(ci, /^          persist-credentials: false$/);
    expectLine(ci, /^        run: bun install --frozen-lockfile$/);
  });

  test("release workflow publishes npm with trusted publishing OIDC", async () => {
    const release = await workflow("release.yml");

    expect(release).toContain("permissions:\n  contents: write\n  id-token: write");
    expect(release).toContain("concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false");
    expectLine(release, /^    timeout-minutes: 30$/);
    expectPinnedAction(release, "actions/checkout");
    expectPinnedAction(release, "actions/setup-node");
    expectPinnedAction(release, "oven-sh/setup-bun");
    expectPinnedAction(release, "softprops/action-gh-release");
    expectNoFloatingActionTags(release);
    expectLine(release, /^          persist-credentials: false$/);
    expectLine(release, /^          node-version: "24"$/);
    expectLine(release, /^          registry-url: https:\/\/registry\.npmjs\.org$/);
    expectLine(release, /^          package-manager-cache: false$/);
    expectLine(release, /^        run: npm install -g npm@latest$/);
    expectLine(release, /^        run: bun install --frozen-lockfile$/);
    expect(release).toContain("Tag ${GITHUB_REF_NAME} does not match package version v${PACKAGE_VERSION}");
    expect(release).toContain("npm publish --access public");
    for (const envName of NPM_AUTH_ENV_NAMES) {
      expect(release).not.toContain(envName);
    }
    expect(release).not.toContain(`npm publish ${PROVENANCE_FLAG}`);
  });
});
