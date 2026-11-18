import type { Evidence, Resource } from "@kypa/sdk";
import { expect, test } from "vitest";
import { pinnedDependencies } from "./index.js";

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
