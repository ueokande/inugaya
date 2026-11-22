import type { Resource } from "@inugaya/sdk";
import { expect, test } from "vitest";
import { actionsLockfile, builtInRules } from "./index.js";

const resource: Resource = {
  provider: "github",
  type: "repository",
  id: "1",
  name: "org/repo",
  url: "",
  metadata: {},
};

test.each([
  { present: true, hasWorkflows: true, applicable: true, findings: 0 },
  { present: false, hasWorkflows: true, applicable: true, findings: 1 },
  { present: false, hasWorkflows: false, applicable: false, findings: 0 },
])(
  "checks presence for repositories with workflows ($present, $hasWorkflows)",
  ({ present, hasWorkflows, applicable, findings }) => {
    expect(builtInRules).toContain(actionsLockfile);
    expect(actionsLockfile.requiredEvidence).toEqual([
      "github/actions-lockfile@1",
    ]);
    const result = actionsLockfile.evaluate(
      resource,
      {
        "github/actions-lockfile@1": {
          state: "available",
          observedAt: "",
          data: { present, hasWorkflows },
        },
      },
      {},
    );
    expect(result.applicable).toBe(applicable);
    expect(result.findings).toHaveLength(findings);
  },
);

test("unavailable evidence errors; empty repositories are not applicable; parameters are strict", () => {
  expect(() => actionsLockfile.evaluate(resource, {}, {})).toThrow();
  expect(
    actionsLockfile.evaluate(
      resource,
      {
        "github/actions-lockfile@1": {
          state: "not-applicable",
          observedAt: "",
        },
      },
      {},
    ).applicable,
  ).toBe(false);
  expect(actionsLockfile.validateParameters({})).toEqual({});
  expect(() =>
    actionsLockfile.validateParameters({ allowMissing: true }),
  ).toThrow();
});
