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

const fixtureResource = {
  provider: "github",
  type: "repository",
  id: "42",
  name: "fixture/target",
  url: "https://github.com/fixture/target",
  metadata: { defaultBranch: "main" },
};

function fixtureProvider(fetch: typeof globalThis.fetch) {
  return createGitHubProvider({
    token: fixtureToken,
    concurrency: 4,
    requestTimeoutSeconds: 30,
    retries: 0,
    fetch,
  });
}

test("a truncated recursive tree still evaluates workflow pins, the lockfile, Renovate, and Dependabot", async () => {
  const fixture = createRepositoryFixture("dependency-age-configured", {
    truncatedRecursive: true,
  });
  const selected = builtInRules.filter((rule) =>
    [
      "actions/pinned-dependencies",
      "actions/lockfile",
      "renovate/minimum-release-age",
      "dependabot/cooldown",
    ].includes(rule.id),
  );
  expect(selected).toHaveLength(4);
  const resource = structuredClone(fixtureResource);
  const ids = [
    "github/dependabot-config@1",
    ...new Set(
      selected
        .flatMap((rule) => rule.requiredEvidence)
        .filter((id) => id !== "github/dependabot-config@1"),
    ),
  ];
  const evidence = await fixtureProvider(fixture.fetch).collect(resource, ids);
  for (const rule of selected) {
    const parameters = rule.validateParameters({});
    expect(
      await rule.evaluate(resource, evidence, parameters),
      rule.id,
    ).toEqual({
      applicable: true,
      findings: [],
    });
  }
  const requests = fixture.requests.filter((request) =>
    request.includes("/git/trees/"),
  );
  expect(requests).toHaveLength(4); // Recursive probe, root, .github, workflows.
  expect(new Set(requests).size).toBe(requests.length);
});

test.each([
  ["dependency-age-configured", undefined, "found", 2],
  ["no-workflows", undefined, "absent", 1],
  ["dependency-age-configured", ".github", "unavailable", 2],
] as const)(
  "Dependabot reads the known path in %s (%s)",
  async (name, truncatedDirectory, outcome, reads) => {
    const fixture = createRepositoryFixture(
      name,
      truncatedDirectory === undefined
        ? { truncatedRecursive: true }
        : { truncatedRecursive: true, truncatedDirectory },
    );
    const id = "github/dependabot-config@1";
    const evidence = (
      await fixtureProvider(fixture.fetch).collect(
        structuredClone(fixtureResource),
        [id],
      )
    )[id];
    if (outcome === "unavailable") {
      expect(evidence).toMatchObject({
        state: "unavailable",
        code: "TRUNCATED_TREE",
      });
    } else {
      expect(evidence).toMatchObject({
        state: "available",
        data:
          outcome === "absent"
            ? null
            : {
                path: ".github/dependabot.yml",
                url: expect.stringContaining(`/blob/${fixtureCommit}/`),
              },
      });
    }
    const requests = fixture.requests.filter((request) =>
      request.includes("/git/trees/"),
    );
    expect(requests).toHaveLength(reads);
    expect(requests.every((request) => !request.includes("?recursive="))).toBe(
      true,
    );
  },
);
