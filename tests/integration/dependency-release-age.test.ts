import { expect, test } from "vitest";
import { createGitHubProvider } from "../../packages/provider-github/src/index.js";
import { builtInRules } from "../../packages/rules-github/src/index.js";
import {
  createRepositoryFixture,
  fixtureCommit,
  fixtureToken,
} from "../helpers/github-repository.js";

const rules = builtInRules.filter((rule) =>
  ["renovate/minimum-release-age", "dependabot/cooldown"].includes(rule.id),
);

test.each([
  ["dependency-age-configured", [0, 0]],
  ["dependency-age-missing", [1, 2]],
  ["dependency-age-invalid", [null, null]],
  ["no-workflows", [-1, -1]],
] as const)("checks update settings in %s", async (repository, expected) => {
  expect(rules).toHaveLength(2);
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
    const count = expected[index];
    if (count === undefined) throw new Error("Missing fixture expectation.");
    if (count === null) {
      const [id] = rule.requiredEvidence;
      if (!id) throw new Error("Missing required evidence ID.");
      expect(evidence[id]).toMatchObject({
        state: "unavailable",
        code: "INVALID_UPDATE_CONFIG",
      });
      expect(() => rule.evaluate(resource, evidence, {})).toThrow();
      continue;
    }
    const result = await rule.evaluate(resource, evidence, {});
    expect(result.applicable).toBe(count !== -1);
    expect(result.findings).toHaveLength(Math.max(0, count));
    for (const finding of result.findings) {
      expect(finding.location?.url).toContain(
        `/blob/${fixtureCommit}/${finding.location?.path}`,
      );
    }
  }
  expect(
    fixture.requests.filter((request) => request.includes("/git/trees/")),
  ).toHaveLength(1);
});
