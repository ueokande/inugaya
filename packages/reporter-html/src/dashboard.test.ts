import type { Report } from "@kypa/sdk";
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
