import { describe, expect, test } from "bun:test";

const rootDir = new URL("../..", import.meta.url).pathname;

async function workflow(name: string): Promise<string> {
  return Bun.file(`${rootDir}/.github/workflows/${name}`).text();
}

function expectLine(text: string, pattern: RegExp): void {
  expect(text.split("\n").some((line) => pattern.test(line))).toBe(true);
}

const SHA_PIN = "[0-9a-f]{40}";

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

  test("release workflow limits token handling and avoids concurrent tag publishes", async () => {
    const release = await workflow("release.yml");

    expect(release).toContain("permissions:\n  contents: write");
    expect(release).toContain("concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false");
    expectLine(release, /^    timeout-minutes: 30$/);
    expectPinnedAction(release, "actions/checkout");
    expectPinnedAction(release, "oven-sh/setup-bun");
    expectPinnedAction(release, "softprops/action-gh-release");
    expectNoFloatingActionTags(release);
    expectLine(release, /^          persist-credentials: false$/);
    expectLine(release, /^        run: bun install --frozen-lockfile$/);
    expect(release).toContain("Tag ${GITHUB_REF_NAME} does not match package version v${PACKAGE_VERSION}");
    expect(release).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(release).toContain("chmod 0600 ~/.npmrc");
  });
});
