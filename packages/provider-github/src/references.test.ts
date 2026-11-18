import * as fs from "node:fs";
import { expect, test } from "vitest";
import { collectReferences } from "./references.js";

const fixture = (relative: string) =>
  fs.readFileSync(
    new URL(
      `../../../tests/fixtures/repositories/references/${relative}`,
      import.meta.url,
    ),
    "utf8",
  );

test("collects step and reusable workflow references with commit-pinned locations", () => {
  const refs = collectReferences(
    fixture(".github/workflows/ci.yml"),
    ".github/workflows/ci.yml",
    "org/repo",
    "a".repeat(40),
  );
  expect(refs.map((item) => item.reference)).toEqual([
    "actions/checkout@v4",
    `company/check@${"0123456789abcdef0123456789abcdef01234567"}`,
    "company/workflows/.github/workflows/check.yml@main",
  ]);
  expect(refs[0]?.line).toBe(7);
  expect(refs[0]?.url).toContain(
    `/blob/${"a".repeat(40)}/.github/workflows/ci.yml#L7`,
  );
});

test("collects composite references but not JavaScript Action manifests", () => {
  expect(
    collectReferences(
      fixture(".github/actions/local/action.yml"),
      "action.yaml",
      "org/repo",
      "a".repeat(40),
    ),
  ).toHaveLength(1);
  expect(
    collectReferences(
      fixture(".github/actions/javascript/action.yml"),
      "action.yml",
      "org/repo",
      "a".repeat(40),
    ),
  ).toEqual([]);
});

test.each([
  "invalid-reference",
  "non-string-reference",
  "expression-reference",
])("unsupported references cannot silently pass: %s", (name) => {
  expect(() =>
    collectReferences(
      fixture(`.github/workflows/${name}.yml`),
      ".github/workflows/ci.yml",
      "org/repo",
      "a".repeat(40),
    ),
  ).toThrow();
});

test("same-repository $/ references are local and require no external SHA", () => {
  expect(
    collectReferences(
      fixture(".github/workflows/same-repository.yml"),
      ".github/workflows/ci.yml",
      "org/repo",
      "a".repeat(40),
    ),
  ).toEqual([]);
});

test.each(["non-string-runtime", "unknown-runtime", "missing-steps"])(
  "invalid Action manifests cannot become not-applicable evaluations: %s",
  (name) => {
    expect(() =>
      collectReferences(
        fixture(`.github/actions/${name}/action.yml`),
        "action.yml",
        "org/repo",
        "a".repeat(40),
      ),
    ).toThrow();
  },
);

test("same-repository $/ references reject an explicit @ref", () => {
  expect(() =>
    collectReferences(
      fixture(".github/workflows/same-repository-ref.yml"),
      ".github/workflows/ci.yml",
      "org/repo",
      "a".repeat(40),
    ),
  ).toThrow("cannot specify @ref");
});
