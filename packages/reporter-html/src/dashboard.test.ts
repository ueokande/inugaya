import type { Report } from "@inugaya/sdk";
import { JSDOM } from "jsdom";
import { afterEach, expect, test, vi } from "vitest";
import dashboardReport from "../../../tests/fixtures/reports/dashboard.json" with {
  type: "json",
};
import { renderReport } from "./dashboard.js";

afterEach(() => vi.unstubAllGlobals());

test("renders partial coverage, escapes untrusted values, and filters evaluations", () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://example.org/monitor/",
  });
  vi.stubGlobal("document", dom.window.document);
  const report = structuredClone(dashboardReport) as Report;
  expect(() =>
    renderReport({ ...report, schemaVersion: 999 } as unknown as Report),
  ).toThrow("Unsupported report format");
  renderReport(report);
  expect(document.body.textContent).toContain("Missing coverage");
  expect(document.body.textContent).toContain("<script>alert(1)</script>");
  expect(document.querySelectorAll("script,img")).toHaveLength(0);
  expect(document.querySelector("a")).toBeNull();
  expect(
    [...document.querySelectorAll(".metric")].map((item) => item.textContent),
  ).toEqual([
    "Repositories1/1",
    "Violations1",
    "Warnings1",
    "Coverage errors1",
  ]);
  const level = [...document.querySelectorAll("label")]
    .find((label) => label.firstChild?.textContent === "Level")
    ?.querySelector("select");
  if (!level) throw new Error("Level filter missing");
  level.value = "warn";
  level.dispatchEvent(new dom.window.Event("input"));
  expect(document.querySelectorAll("article")).toHaveLength(1);
  expect(document.querySelector("article")?.textContent).toContain("Warning");
  const search = document.querySelector<HTMLInputElement>(".filters input");
  if (!search) {
    throw new Error("Search missing");
  }
  search.value = "absent";
  search.dispatchEvent(new dom.window.Event("input"));
  expect(document.querySelectorAll("article")).toHaveLength(0);
  dom.window.close();
});

test("switches repositories, scopes coverage, and lets owners reopen all evaluations", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  vi.stubGlobal("document", dom.window.document);
  const report = structuredClone(dashboardReport) as Report;
  const [resource] = report.resources;
  const [evaluation] = report.evaluations;
  const [finding] = report.findings;
  if (!resource || !evaluation || !finding)
    throw new Error("Incomplete test report");
  resource.name = "org/api";
  report.resources.push({ ...resource, id: "2", name: "org/web" });
  report.evaluations.push({
    ...evaluation,
    resource: "github/repository/2",
    rule: "test/web",
    status: "pass",
    findingIds: [],
  });
  report.errors.push({
    phase: "collection",
    code: "TIMEOUT",
    message: "Repository lookup timed out.",
    resource: "github/repository/1",
  });
  if (finding.location)
    finding.location.url = "https://github.com/org/api/blob/sha/file#L1";
  renderReport(report);

  const button = (name: string) => {
    const match = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith(name),
    );
    if (!match) throw new Error(`Missing button: ${name}`);
    return match;
  };
  expect(document.querySelector(".detail-pane h2")?.textContent).toBe(
    "All repositories",
  );
  button("org/api").click();
  expect(document.querySelector(".detail-pane h2")?.textContent).toBe(
    "org/api",
  );
  expect(button("org/api").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".coverage-panel")?.textContent).toContain(
    "Repository lookup timed out.",
  );
  expect(document.querySelector(".coverage-panel")?.textContent).not.toContain(
    "No access",
  );
  const details = document.querySelector("details");
  expect(details?.open).toBe(false);
  details?.querySelector("summary")?.click();
  expect(details?.open).toBe(true);
  expect(details?.textContent).toContain("Remediation");
  expect(details?.querySelector("a")?.href).toBe(finding.location?.url);

  const repositorySearch =
    document.querySelector<HTMLInputElement>(".sidebar input");
  if (!repositorySearch) throw new Error("Missing repository search");
  repositorySearch.value = "web";
  repositorySearch.dispatchEvent(new dom.window.Event("input"));
  expect(button("org/api").parentElement?.hidden).toBe(true);
  expect(button("org/web").parentElement?.hidden).toBe(false);
  button("org/web").click();
  expect(document.querySelector(".detail-pane h2")?.textContent).toBe(
    "org/web",
  );
  expect(document.querySelectorAll("article")).toHaveLength(0);
  button("All evaluations").click();
  expect(document.querySelector("article")?.textContent).toContain("test/web");
  expect(document.querySelector("article")?.textContent).toContain("Passed");
  button("All repositories").click();
  expect(document.querySelectorAll("article")).toHaveLength(3);
  dom.window.close();
});
