import { expect, test } from "vitest";
import { createGitHubProvider } from "../../packages/provider-github/src/index.js";
import { builtInRules } from "../../packages/rules-github/src/index.js";
import {
  createRepositoryFixture,
  fixtureCommit,
  fixtureToken,
} from "../helpers/github-repository.js";

const ruleIds = [
  "npm/min-release-age",
  "pnpm/minimum-release-age",
  "yarn/minimal-age-gate",
  "bun/minimum-release-age",
  "deno/minimum-dependency-age",
  "uv/exclude-newer",
  "poetry/min-release-age",
  "composer/cooldown",
  "mise/minimum-release-age",
  "npm-check-updates/cooldown",
  "pip/uploaded-prior-to",
];
const rules = ruleIds.map((id) => {
  const rule = builtInRules.find((rule) => rule.id === id);
  if (!rule) throw new Error(`Missing rule ${id}`);
  return rule;
});

test.each([
  ["tool-age-configured", Array(11).fill(0)],
  ["tool-age-violations", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]],
  [
    "tool-age-dynamic",
    ["dynamic", -1, -1, "parse", "parse", -1, -1, -1, -1, "parse", "dynamic"],
  ],
  ["tool-age-legacy", [-1, 0, -1, -1, 0, -1, 1, -1, -1, -1, 0]],
  ["no-workflows", Array(11).fill(-1)],
] as const)("checks tool release ages in %s", async (repository, expected) => {
  const fixture = createRepositoryFixture(repository);
  const provider = createGitHubProvider({
    token: fixtureToken,
    concurrency: 4,
    requestTimeoutSeconds: 30,
    retries: 0,
    fetch: fixture.fetch,
  });
  const { resources } = await provider.discover({
    orgs: [],
    repos: ["fixture/target"],
    exclude: [],
    includeArchived: false,
    includeForks: false,
  });
  const resource = resources[0];
  if (!resource) throw new Error("Fixture repository was not discovered.");
  const evidence = await provider.collect(
    resource,
    rules.flatMap((rule) => rule.requiredEvidence),
  );

  for (const [index, rule] of rules.entries()) {
    const count: unknown = expected[index];
    if (count === "parse" || count === "dynamic") {
      const [id] = rule.requiredEvidence;
      if (!id) throw new Error("Missing rule evidence ID.");
      expect(evidence[id]?.state, rule.id).toBe(
        count === "parse" ? "unavailable" : "available",
      );
      expect(() => rule.evaluate(resource, evidence, {}), rule.id).toThrow(
        count === "parse" ? "Unavailable evidence" : "dynamic value",
      );
      continue;
    }
    if (typeof count !== "number")
      throw new Error("Missing fixture expectation.");
    const result = await rule.evaluate(resource, evidence, {});
    expect(result.applicable, rule.id).toBe(count !== -1);
    expect(result.findings, rule.id).toHaveLength(Math.max(0, count));
    for (const finding of result.findings) {
      expect(finding.location?.url).toContain(`/blob/${fixtureCommit}/`);
    }
    if (
      repository === "tool-age-violations" &&
      rule.id === "pip/uploaded-prior-to"
    ) {
      expect(result.findings.map(({ location }) => location?.line)).toEqual([
        13, 14,
      ]);
    }
  }
  expect(
    fixture.requests.filter((request) => request.includes("/git/trees/")),
  ).toHaveLength(1);
  const blobReads = fixture.requests.filter((request) =>
    request.includes("/git/blobs/"),
  );
  expect(new Set(blobReads).size).toBe(blobReads.length);
});
