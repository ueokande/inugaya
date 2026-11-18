import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { afterEach, expect, test } from "vitest";
import { loadPolicy, runScan } from "../../packages/core/src/index.js";
import { createGitHubProvider } from "../../packages/provider-github/src/index.js";
import { createHtmlReporter } from "../../packages/reporter-html/src/index.js";
import { jsonReporter } from "../../packages/reporter-json/src/index.js";
import { builtInRules } from "../../packages/rules-github/src/index.js";
import { findingCounts, shouldFail } from "../../packages/sdk/src/index.js";
import cases from "../fixtures/cases.json" with { type: "json" };
import {
  createRepositoryFixture,
  fixtureCommit,
  fixtureToken,
  policyFile,
  repositoryDirectory,
} from "../helpers/github-repository.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        fsPromises.rm(directory, { recursive: true, force: true }),
      ),
  );
});

test.each(cases)(
  "$repository repository / $policy policy",
  async ({
    repository,
    policy: profile,
    violations,
    warnings,
    errorCodes,
    locations,
  }) => {
    const directory = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "inugaya-repository-"),
    );
    directories.push(directory);
    const config = path.join(directory, "inugaya.yaml");
    await fsPromises.copyFile(policyFile(profile), config);
    const loaded = await loadPolicy(config, builtInRules);
    const fixture = createRepositoryFixture(repository);
    const report = await runScan(loaded.policy, {
      provider: createGitHubProvider({
        token: fixtureToken,
        ...loaded.policy.scan,
        retries: 0,
        fetch: fixture.fetch,
      }),
      rules: builtInRules,
      reporters: [
        jsonReporter,
        createHtmlReporter(
          url.fileURLToPath(new URL("../fixtures/dashboard/", import.meta.url)),
        ),
      ],
      policyDirectory: loaded.directory,
      policyDigest: loaded.digest,
      now: () => new Date("2026-01-01T00:00:00Z"),
      runId: () => "repository-fixture",
    });
    expect(report.scope.discovered).toBe(1);
    expect(report.scope.evaluated).toBe(1);
    expect(report.resources[0]?.metadata.scannedCommit).toBe(fixtureCommit);
    expect(report.evaluations).toHaveLength(loaded.policy.rules.length);
    expect(findingCounts(report)).toEqual({ violations, warnings });
    if (locations) {
      expect(
        report.findings.map((finding) => ({
          path: finding.location?.path,
          line: finding.location?.line,
        })),
      ).toEqual(locations);
    }
    expect(report.errors.map((error) => error.code)).toEqual(errorCodes);
    expect(report.run.status).toBe(errorCodes.length ? "partial" : "complete");
    expect(shouldFail(report, "violation")).toBe(
      violations > 0 || errorCodes.length > 0,
    );
    expect(shouldFail(report, "error")).toBe(errorCodes.length > 0);
    expect(shouldFail(report, "never")).toBe(false);
    for (const evaluation of report.evaluations) {
      const findings = report.findings.filter(
        (finding) => finding.rule === evaluation.rule,
      );
      expect(evaluation.findingIds).toEqual(
        findings.map((finding) => finding.id),
      );
      expect(
        findings.every((finding) => finding.level === evaluation.level),
      ).toBe(true);
      if (!errorCodes.length)
        expect(evaluation.status).toBe(
          findings.length
            ? "fail"
            : ["no-workflows", "local-only"].includes(repository)
              ? "not-applicable"
              : "pass",
        );
    }
    for (const finding of report.findings) {
      if (!finding.location) continue;
      const source = await fsPromises.readFile(
        new URL(finding.location.path, repositoryDirectory(repository)),
        "utf8",
      );
      expect(source.split("\n")[finding.location.line - 1]).toMatch(/uses:/);
      expect(finding.location.url).toContain(
        `/blob/${fixtureCommit}/${finding.location.path}#L${finding.location.line}`,
      );
    }
    const requests = fixture.requests.filter((request) =>
      request.includes("/git/trees/"),
    );
    expect(requests).toHaveLength(1);
    const blobs = fixture.requests.filter((request) =>
      request.includes("/git/blobs/"),
    );
    expect(new Set(blobs).size).toBe(blobs.length);
    if (profile === "sha-only") expect(blobs).toHaveLength(1);
    if (repository === "duplicate-blobs") expect(blobs).toHaveLength(2);
    for (const filename of ["report/report.json", "site/data.json"]) {
      const content = await fsPromises.readFile(
        path.join(directory, filename),
        "utf8",
      );
      expect(JSON.parse(content)).toEqual(report);
      expect(content).not.toContain(fixtureToken);
      expect(content).not.toContain("jobs:");
    }
    expect(
      await fsPromises.readFile(
        path.join(directory, "site/index.html"),
        "utf8",
      ),
    ).toContain('<base href="/">');
  },
);

test("file caches are shared by evidence collectors but reset for the next collection", async () => {
  const fixture = createRepositoryFixture("duplicate-blobs");
  const provider = createGitHubProvider({
    token: fixtureToken,
    concurrency: 4,
    requestTimeoutSeconds: 30,
    retries: 0,
    fetch: fixture.fetch,
    now: () => Date.parse("2026-01-01T00:00:00Z"),
  });
  const discovery = await provider.discover({
    orgs: [],
    repos: ["fixture/target"],
    exclude: [],
    includeArchived: false,
    includeForks: false,
  });
  const resource = discovery.resources[0];
  if (!resource) throw new Error("Fixture repository was not discovered.");
  const ids = ["github/action-references@1", "github/actions-lockfile@1"];
  const first = await provider.collect(resource, ids);
  const second = await provider.collect(resource, ids);
  expect(first["github/action-references@1"]?.state).toBe("available");
  expect(first["github/actions-lockfile@1"]?.state).toBe("available");
  expect(second).toEqual(first);
  expect(resource.metadata.scannedCommit).toBe(fixtureCommit);
  const references = first["github/action-references@1"];
  expect(references).toMatchObject({
    state: "available",
    data: {
      references: [
        { path: ".github/workflows/ci.yml", line: 7 },
        { path: ".github/workflows/other.yaml", line: 7 },
      ],
    },
  });
  expect(JSON.stringify(first)).not.toContain("steps:");
  expect(JSON.stringify(first)).not.toContain(fixtureToken);
  expect(
    fixture.requests.filter((request) => request.includes("/git/trees/")),
  ).toHaveLength(2);
  const blobs = fixture.requests.filter((request) =>
    request.includes("/git/blobs/"),
  );
  expect(blobs).toHaveLength(4);
  expect(new Set(blobs).size).toBe(2);
});
