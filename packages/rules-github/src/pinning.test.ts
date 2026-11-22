import type { Evidence, Resource } from "@inugaya/sdk";
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
function evidence(reference: string, present: boolean, source = path) {
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
    "github/actions-lockfile@1": available({ present, hasWorkflows: true }),
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
  const shaEvidence = evidence(`org/action@${sha}`, false);
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
      evidence("org/action@v1", true),
      shaOnly,
    ).findings,
  ).toHaveLength(1);
  expect(
    pinnedDependencies.evaluate(resource, shaEvidence, lockOnly).findings,
  ).toHaveLength(1);
});

test("a committed lockfile satisfies the lockfile method for local composite references", () => {
  const input = evidence(
    "org/action@v1",
    true,
    ".github/actions/local/action.yml",
  );
  expect(pinnedDependencies.evaluate(resource, input, {}).findings).toEqual([]);
});

test("unavailable lockfile evidence never silently falls back to SHA", () => {
  const data = evidence(`org/action@${sha}`, false);
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
