import type { Report } from "@kypa/sdk";
import { JSDOM } from "jsdom";
import { afterEach, expect, test, vi } from "vitest";
import { renderReport } from "./dashboard.js";

afterEach(() => vi.unstubAllGlobals());

test("renders partial coverage, escapes untrusted values, and filters evaluations", () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://example.org/monitor/",
  });
  vi.stubGlobal("document", dom.window.document);
  const resource = {
    provider: "github",
    type: "repository",
    id: "1",
    name: "<img src=x onerror=alert(1)>",
    url: "",
    metadata: {},
  };
  const report: Report = {
    schemaVersion: 1,
    run: {
      id: "fixture",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:00Z",
      toolVersion: "0.1.0",
      policyVersion: 1,
      policyDigest: "",
      status: "partial",
    },
    scope: {
      requested: {
        orgs: [],
        repos: [],
        exclude: [],
        includeArchived: false,
        includeForks: false,
      },
      discovered: 1,
      evaluated: 1,
      excluded: [],
      discoveryLimitedToAccessibleResources: true,
    },
    resources: [resource],
    evaluations: [
      {
        resource: "github/repository/1",
        rule: "test/rule",
        ruleVersion: "1",
        severity: "high",
        level: "error",
        status: "fail",
        findingIds: ["1"],
        evidence: [],
      },
    ],
    findings: [
      {
        id: "1",
        key: "key",
        resource: "github/repository/1",
        rule: "test/rule",
        ruleVersion: "1",
        severity: "high",
        level: "error",
        message: "<script>alert(1)</script>",
        remediation: "Fix",
        location: { path: "file", line: 1, url: "javascript:alert(1)" },
      },
    ],
    errors: [{ phase: "collection", code: "ACCESS", message: "No access" }],
    warnings: [],
  };
  const warning = report.findings[0];
  const evaluation = report.evaluations[0];
  if (!warning || !evaluation) throw new Error("Missing fixture");
  report.findings.push({
    ...warning,
    id: "2",
    rule: "test/warning",
    level: "warn",
  });
  report.evaluations.push({
    ...evaluation,
    rule: "test/warning",
    level: "warn",
    findingIds: ["2"],
  });
  expect(() =>
    renderReport({ ...report, schemaVersion: 999 } as unknown as Report),
  ).toThrow("Unsupported report format");
  renderReport(report);
  expect(document.body.textContent).toContain("Missing coverage");
  expect(document.body.textContent).toContain("<script>alert(1)</script>");
  expect(document.querySelectorAll("script,img")).toHaveLength(0);
  expect(document.querySelector("a")?.hasAttribute("href")).toBe(false);
  expect(document.body.textContent).toContain(
    "1 violations · 1 warnings · 1 scan errors",
  );
  const level = [...document.querySelectorAll("label")]
    .find((label) => label.firstChild?.textContent === "Level")
    ?.querySelector("select");
  if (!level) throw new Error("Level filter missing");
  level.value = "warn";
  level.dispatchEvent(new dom.window.Event("input"));
  expect(document.querySelectorAll("article")).toHaveLength(1);
  expect(document.querySelector("article")?.textContent).toContain(
    "fail · warn · high",
  );
  const search = document.querySelector("input");
  if (!search) {
    throw new Error("Search missing");
  }
  search.value = "absent";
  search.dispatchEvent(new dom.window.Event("input"));
  expect(document.querySelectorAll("article")).toHaveLength(0);
  dom.window.close();
});
