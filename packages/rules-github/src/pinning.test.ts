import type { Evidence, Resource } from "@kypa/sdk";
import { findingCounts, shouldFail } from "@kypa/sdk";
import { expect, test, vi } from "vitest";
import { parsePolicy, runScan } from "../../core/src/index.js";
import { builtInRules, pinnedDependencies } from "./index.js";

const sha = "a".repeat(40);
const path = ".github/workflows/ci.yml";
const resource: Resource = {
  provider: "github",
  type: "repository",
  id: "1",
  name: "org/repo",
  url: "",
  metadata: {},
};
const available = (data: unknown): Evidence => ({
  state: "available",
  observedAt: "",
  data,
});
const locked = {
  version: "v0.0.3",
  workflows: { [path]: ["org/action@v1"] },
  dependencies: {
    "org/action@v1": {
      ref: "v1",
      commit: `sha1-${sha}`,
      owner_id: 1,
      repo_id: 2,
    },
  },
};
function evidence(reference: string, lockfile: unknown, source = path) {
  return {
    "github/action-references@1": available({
      references: [
        {
          reference,
          path: source,
          line: 5,
          url: "https://github.com/org/repo/blob/abc/ci.yml#L5",
        },
      ],
    }),
    "github/actions-lockfile@1": available({ lockfile }),
  };
}
const profiles = {
  sha: "actions/full-sha: {level: error}",
  lock: "actions/lockfile: {level: error}",
  either:
    "actions/pinned-dependencies: {level: error, parameters: {acceptedMethods: [full-sha, lockfile]}}",
  migration:
    "actions/pinned-dependencies: {level: error}\n  actions/lockfile: {level: warn}",
};

test.each([
  ["sha", true, false, 0, 0],
  ["sha", false, true, 1, 0],
  ["sha", true, true, 0, 0],
  ["sha", false, false, 1, 0],
  ["lock", true, false, 1, 0],
  ["lock", false, true, 0, 0],
  ["lock", true, true, 0, 0],
  ["lock", false, false, 1, 0],
  ["either", true, false, 0, 0],
  ["either", false, true, 0, 0],
  ["either", true, true, 0, 0],
  ["either", false, false, 1, 0],
  ["migration", true, false, 0, 1],
  ["migration", false, true, 0, 0],
  ["migration", true, true, 0, 0],
  ["migration", false, false, 1, 1],
] as const)(
  "%s policy: SHA=%s lockfile=%s yields %i violations and %i warnings",
  async (profile, hasSha, hasLock, violations, warnings) => {
    const policy = parsePolicy(
      `version: 1\ntargets: {repos: [org/repo]}\nrules:\n  ${profiles[profile]}\nreporters: [{name: json, options: {path: report.json}}]`,
      builtInRules,
    );
    const collect = vi.fn(async () =>
      evidence(`org/action@${hasSha ? sha : "v1"}`, hasLock ? locked : null),
    );
    const report = await runScan(policy, {
      provider: {
        id: "github",
        discover: async () => ({
          resources: [resource],
          errors: [],
          excluded: [],
        }),
        collect,
      },
      rules: builtInRules,
      reporters: [{ id: "json", write: async () => {} }],
      policyDirectory: "",
      policyDigest: "",
    });
    expect(findingCounts(report)).toEqual({ violations, warnings });
    expect(report.errors).toEqual([]);
    expect(report.run.status).toBe("complete");
    expect(shouldFail(report, "violation")).toBe(violations > 0);
    expect(shouldFail(report, "error")).toBe(false);
    expect(shouldFail(report, "never")).toBe(false);
    expect(
      report.evaluations.every(
        (item) =>
          item.level ===
          (item.rule === "actions/lockfile" && profile === "migration"
            ? "warn"
            : "error"),
      ),
    ).toBe(true);
    expect(collect).toHaveBeenCalledOnce();
    const ids = collect.mock.calls[0] as unknown as [Resource, string[]];
    expect(new Set(ids[1]).size).toBe(ids[1].length);
  },
);

test("acceptedMethods defaults and strict validation", () => {
  expect(pinnedDependencies.validateParameters({})).toEqual({
    acceptedMethods: ["full-sha", "lockfile"],
  });
  for (const value of [[], ["unknown"], ["full-sha", "full-sha"], "full-sha"]) {
    expect(() =>
      pinnedDependencies.validateParameters({ acceptedMethods: value }),
    ).toThrow();
  }
  expect(() =>
    pinnedDependencies.validateParameters({ extra: true }),
  ).toThrow();
});

test("single-method policies enforce their method and only SHA-only skips lockfile evidence", () => {
  const shaOnly = { acceptedMethods: ["full-sha"] };
  const lockOnly = { acceptedMethods: ["lockfile"] };
  expect(pinnedDependencies.getRequiredEvidence?.(shaOnly)).toEqual([
    "github/action-references@1",
  ]);
  const shaEvidence = evidence(`org/action@${sha}`, null);
  expect(
    pinnedDependencies.evaluate(
      resource,
      {
        "github/action-references@1": shaEvidence["github/action-references@1"],
      },
      shaOnly,
    ).findings,
  ).toEqual([]);
  expect(
    pinnedDependencies.evaluate(
      resource,
      evidence("org/action@v1", locked),
      shaOnly,
    ).findings,
  ).toHaveLength(1);
  expect(
    pinnedDependencies.evaluate(resource, shaEvidence, lockOnly).findings,
  ).toHaveLength(1);
});

test("uncovered references are reported individually, including reusable workflows and composite manifests", () => {
  for (const [ref, source] of [
    ["org/repo/.github/workflows/reuse.yml@v1", path],
    ["org/action@v1", "local/action.yml"],
  ]) {
    expect(
      pinnedDependencies.evaluate(
        resource,
        evidence(ref as string, locked, source),
        {},
      ).findings,
    ).toHaveLength(1);
    expect(
      pinnedDependencies.evaluate(
        resource,
        evidence((ref as string).replace("@v1", `@${sha}`), locked, source),
        {},
      ).findings,
    ).toEqual([]);
  }
});

test("malformed, unsupported, and unavailable lockfiles never silently fall back to SHA", () => {
  for (const lockfile of [
    {},
    { ...locked, version: "v9" },
    { ...locked, dependencies: { "org/action@v1": {} } },
  ]) {
    expect(() =>
      pinnedDependencies.evaluate(
        resource,
        evidence(`org/action@${sha}`, lockfile),
        {},
      ),
    ).toThrow();
  }
  const data = evidence(`org/action@${sha}`, null);
  expect(() =>
    pinnedDependencies.evaluate(
      resource,
      {
        ...data,
        "github/actions-lockfile@1": {
          state: "unavailable",
          observedAt: "",
          code: "ACCESS",
          message: "No access",
        },
      },
      {},
    ),
  ).toThrow();
});

test("no references or empty repository is not applicable", () => {
  expect(
    pinnedDependencies.evaluate(
      resource,
      { "github/action-references@1": available({ references: [] }) },
      {},
    ).applicable,
  ).toBe(false);
  expect(
    pinnedDependencies.evaluate(
      resource,
      {
        "github/action-references@1": {
          state: "not-applicable",
          observedAt: "",
        },
      },
      {},
    ).applicable,
  ).toBe(false);
});

test("runner requests only reference evidence for a SHA-only combined policy", async () => {
  const policy = parsePolicy(
    `version: 1
targets: {repos: [org/repo]}
rules:
  actions/pinned-dependencies:
    parameters: {acceptedMethods: [full-sha]}
reporters: [{name: json, options: {path: report.json}}]`,
    builtInRules,
  );
  const data = evidence(`org/action@${sha}`, null);
  const collect = vi.fn(async (_resource: Resource, ids: readonly string[]) => {
    expect(ids).toEqual(["github/action-references@1"]);
    return { "github/action-references@1": data["github/action-references@1"] };
  });
  const report = await runScan(policy, {
    provider: {
      id: "github",
      discover: async () => ({
        resources: [resource],
        errors: [],
        excluded: [],
      }),
      collect,
    },
    rules: builtInRules,
    reporters: [{ id: "json", write: async () => {} }],
    policyDirectory: "",
    policyDigest: "",
  });
  expect(report.evaluations[0]?.status).toBe("pass");
  expect(report.errors).toEqual([]);
  expect(report.evaluations[0]?.evidence.map((item) => item.id)).toEqual([
    "github/action-references@1",
  ]);
});

test("mixed reference protection produces findings only at uncovered uses", () => {
  const data = evidence("org/action@v1", locked);
  data["github/action-references@1"] = available({
    references: [
      {
        reference: "org/action@v1",
        path,
        line: 1,
        url: "https://github.com/org/repo/blob/abc/ci.yml#L1",
      },
      {
        reference: `org/sha-only@${sha}`,
        path,
        line: 2,
        url: "https://github.com/org/repo/blob/abc/ci.yml#L2",
      },
      {
        reference: "org/unpinned@main",
        path,
        line: 3,
        url: "https://github.com/org/repo/blob/abc/ci.yml#L3",
      },
    ],
  });
  const result = pinnedDependencies.evaluate(resource, data, {});
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.location?.line).toBe(3);
});
