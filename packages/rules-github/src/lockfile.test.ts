import type { Evidence, Resource } from "@kypa/sdk";
import { expect, test } from "vitest";
import { actionsLockfile, builtInRules } from "./index.js";

const sha = "a".repeat(40);
const resource: Resource = {
  provider: "github",
  type: "repository",
  id: "1",
  name: "org/repo",
  url: "https://github.com/org/repo",
  metadata: {},
};
const path = ".github/workflows/ci.yml";
const entry = { ref: "v1", commit: `sha1-${sha}`, owner_id: 1, repo_id: 2 };
const lock = () => ({
  version: "v0.0.3",
  workflows: { [path]: ["org/action@v1"] },
  dependencies: { "org/action@v1": { ...entry } },
});
const available = (data: unknown): Evidence => ({
  state: "available",
  observedAt: "",
  data,
});
function evaluate(
  lockfile: unknown,
  reference = "org/action@v1",
  source = path,
) {
  return actionsLockfile.evaluate(
    resource,
    {
      "github/action-references@1": available({
        references: [
          {
            reference,
            path: source,
            line: 7,
            url: "https://github.com/org/repo/blob/abc/ci.yml#L7",
          },
        ],
      }),
      "github/actions-lockfile@1": available({ lockfile }),
    },
    {},
  );
}

test("registered rule accepts locked tags, repository case, sub-actions, and SHA uses backed by tag pins", () => {
  expect(builtInRules).toContain(actionsLockfile);
  for (const ref of [
    "org/action@v1",
    "ORG/Action/subpath@v1",
    `org/action@${sha}`,
  ]) {
    expect(evaluate(lock(), ref)).toEqual({ applicable: true, findings: [] });
  }
});

test("missing lockfile fails even for a full SHA", () => {
  expect(evaluate(null, `org/action@${sha}`).findings[0]?.key).toBe(
    "missing-lockfile",
  );
});

test("missing workflow, changed tag, missing dependency, and mismatched ref fail with source locations", () => {
  const missingWorkflow = lock();
  delete (missingWorkflow.workflows as Record<string, unknown>)[path];
  const missingEntry = lock();
  delete (missingEntry.dependencies as Record<string, unknown>)[
    "org/action@v1"
  ];
  const wrongRef = lock();
  wrongRef.dependencies["org/action@v1"].ref = "v2";
  for (const value of [missingWorkflow, missingEntry, wrongRef]) {
    const result = evaluate(value);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.location?.line).toBe(7);
  }
  expect(evaluate(lock(), "org/action@v2").findings).toHaveLength(1);
});

test("recorded transitive dependencies must exist and be listed for the workflow; cycles terminate", () => {
  const value = {
    ...lock(),
    dependencies: {
      "org/action@v1": { ...entry, uses: ["org/nested@v1"] },
      "org/nested@v1": { ...entry, uses: ["org/action@v1"] },
    },
  };
  expect(evaluate(value).findings).toHaveLength(1);
  value.workflows[path]?.push("org/nested@v1");
  expect(evaluate(value).findings).toEqual([]);
  delete (value.dependencies as Record<string, unknown>)["org/nested@v1"];
  expect(evaluate(value).findings).toHaveLength(1);
});

test.each([
  {},
  { ...lock(), version: "v9" },
  {
    ...lock(),
    dependencies: { "org/action@v1": { ...entry, commit: "not-a-sha" } },
  },
  { ...lock(), dependencies: { "org/action@v1": { ...entry, repo_id: 0 } } },
])("malformed or unsupported lockfiles cannot pass", (value) => {
  expect(() => evaluate(value)).toThrow();
});

test("unsupported native coverage is not applicable", () => {
  expect(
    evaluate(null, "org/repo/.github/workflows/reuse.yml@v1").applicable,
  ).toBe(false);
  expect(evaluate(null, "org/action@v1", "local/action.yml").applicable).toBe(
    false,
  );
  expect(
    actionsLockfile.evaluate(
      resource,
      {
        "github/action-references@1": available({ references: [] }),
        "github/actions-lockfile@1": available({ lockfile: null }),
      },
      {},
    ).applicable,
  ).toBe(false);
});

test("unavailable evidence errors; empty repositories are not applicable; parameters are strict", () => {
  expect(() => actionsLockfile.evaluate(resource, {}, {})).toThrow();
  const empty: Evidence = { state: "not-applicable", observedAt: "" };
  expect(
    actionsLockfile.evaluate(
      resource,
      {
        "github/action-references@1": empty,
        "github/actions-lockfile@1": empty,
      },
      {},
    ).applicable,
  ).toBe(false);
  expect(actionsLockfile.validateParameters({})).toEqual({});
  expect(() =>
    actionsLockfile.validateParameters({ allowMissing: true }),
  ).toThrow();
});
