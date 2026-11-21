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
  report.resources.push(
    { ...resource, id: "2", name: "org/web" },
    { ...resource, id: "3", name: "org/infra" },
  );
  report.evaluations.push({
    ...evaluation,
    resource: "github/repository/2",
    rule: "test/web",
    status: "pass",
    findingIds: [],
  });
  report.errors.push(
    {
      phase: "collection",
      code: "TIMEOUT",
      message: "Repository lookup timed out.",
      resource: "github/repository/1",
    },
    {
      phase: "collection",
      code: "ACCESS",
      message: "Infra unavailable.",
      resource: "github/repository/3",
    },
  );
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
  expect(button("org/web").parentElement?.hidden).toBe(true);
  expect(button("org/infra").parentElement?.hidden).toBe(false);
  expect(button("org/infra").textContent).toContain("Coverage gap");
  button("org/api").click();
  expect(document.querySelector(".detail-pane h2")?.textContent).toBe(
    "org/api",
  );
  expect(document.querySelector(".coverage-panel")?.textContent).toContain(
    "org/api",
  );
  expect(document.querySelector(".coverage-panel")?.textContent).not.toContain(
    "github/repository/1",
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
  expect(button("org/web").parentElement?.hidden).toBe(true);
  expect(
    document.querySelector(".repository-list .empty-state")?.textContent,
  ).toBe("No matching repositories.");
  const showAll = document.querySelector<HTMLInputElement>(
    ".sidebar input[type=checkbox]",
  );
  if (!showAll) throw new Error("Missing repository toggle");
  showAll.click();
  expect(button("org/web").parentElement?.hidden).toBe(false);
  button("org/web").click();
  expect(document.querySelector(".detail-pane h2")?.textContent).toBe(
    "org/web",
  );
  expect(document.querySelectorAll("article")).toHaveLength(0);
  button("All evaluations").click();
  expect(document.querySelector("article")?.textContent).toContain("test/web");
  expect(document.querySelector("article")?.textContent).toContain("Passed");
  showAll.click();
  expect(button("org/web").parentElement?.hidden).toBe(true);
  expect(button("All repositories").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelectorAll("article")).toHaveLength(3);

  renderReport({ ...report, errors: [], evaluations: [] });
  expect(
    document.querySelector(".repository-list .empty-state")?.textContent,
  ).toBe("No repositories need attention.");
  dom.window.close();
});

test("groups identical finding text and lists each location as file and line", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  vi.stubGlobal("document", dom.window.document);
  const report = structuredClone(dashboardReport) as Report;
  const [evaluation] = report.evaluations;
  const [finding] = report.findings;
  if (!evaluation || !finding) throw new Error("Incomplete test report");

  const location = (path: string, line: number) => ({
    path,
    line,
    url: `https://github.com/org/api/blob/sha/${path}#L${line}`,
  });
  finding.location = location(".github/workflows/build.yml", 39);
  const extra = [
    {
      ...finding,
      id: "3",
      location: location(".github/workflows/build.yml", 22),
    },
    {
      ...finding,
      id: "4",
      location: location(".github/workflows/build.yml", 26),
    },
    {
      ...finding,
      id: "5",
      location: location(".github/workflows/test.yml", 10),
    },
    { ...finding, id: "6", remediation: "Use another fix." },
  ];
  report.findings.push(...extra);
  evaluation.findingIds.push(...extra.map(({ id }) => id));
  renderReport(report);

  const row = document.querySelector("article");
  const groups = row?.querySelectorAll(".finding");
  expect(groups).toHaveLength(2);
  const grouped = groups?.[0];
  expect(grouped?.querySelectorAll(".finding-message")).toHaveLength(1);
  expect(grouped?.querySelectorAll(".finding-locations li")).toHaveLength(4);
  const links = [...(grouped?.querySelectorAll("a") ?? [])];
  expect(links.map((link) => link.textContent)).toEqual([
    ".github/workflows/build.yml:22",
    ".github/workflows/build.yml:26",
    ".github/workflows/build.yml:39",
    ".github/workflows/test.yml:10",
  ]);
  expect(links.map((link) => link.hash)).toEqual([
    "#L22",
    "#L26",
    "#L39",
    "#L10",
  ]);
  expect(groups?.[1]?.textContent).toContain("Use another fix.");
  dom.window.close();
});
