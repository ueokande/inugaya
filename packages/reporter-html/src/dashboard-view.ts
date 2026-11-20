import {
  type Evaluation,
  type Finding,
  findingCounts,
  type Report,
} from "@inugaya/sdk";

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

export function badge(
  text: string,
  tone: string,
): HTMLElementTagNameMap["span"] {
  return element("span", text, `badge badge--${tone}`);
}

export function scanHeader(report: Report): HTMLElement {
  const header = element("header", "", "scan-header");
  const brand = element("div", "", "scan-brand");
  const title = element("div", "", "scan-title");
  title.append(
    element("h1", "Inugaya"),
    badge(
      report.run.status === "partial" ? "Partial scan" : "Complete scan",
      report.run.status,
    ),
  );
  const time = element("time");
  time.dateTime = report.run.completedAt;
  time.textContent = report.run.completedAt;
  const metadata = element("p", "Scanned ", "scan-meta");
  metadata.append(time, ` · Run ${report.run.id}`);
  const age = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(report.run.completedAt)) / 3_600_000),
  );
  if (Number.isFinite(age)) metadata.append(` · ${age} hours ago`);
  brand.append(title, metadata);

  const counts = findingCounts(report);
  const metrics = element("dl", "", "metrics");
  for (const [label, value, tone] of [
    [
      "Repositories",
      `${report.scope.evaluated}/${report.scope.discovered}`,
      "neutral",
    ],
    ["Violations", String(counts.violations), "violation"],
    ["Warnings", String(counts.warnings), "warning"],
    ["Coverage errors", String(report.errors.length), "coverage"],
  ] as const) {
    const metric = element("div", "", `metric metric--${tone}`);
    metric.append(element("dt", label), element("dd", value));
    if (label === "Repositories") metric.title = "Processed / discovered";
    metrics.append(metric);
  }
  header.append(brand, metrics);
  return header;
}

export function coveragePanel(errors: Report["errors"]): HTMLElement {
  const section = element("section", "", "coverage-panel");
  if (!errors.length) return section;
  section.append(element("h3", `Coverage errors (${errors.length})`));
  const list = element("ul", "", "coverage-list");
  for (const error of errors) {
    const item = element("li");
    item.append(
      element(
        "strong",
        [error.phase, error.resource, error.rule, error.code]
          .filter(Boolean)
          .join(" · "),
      ),
      element("p", error.message),
    );
    list.append(item);
  }
  section.append(list);
  return section;
}

function findingDetails(finding: Finding): HTMLElement {
  const block = element("div", "", "finding");
  block.append(
    element("p", finding.message, "finding-message"),
    element("h4", "Remediation"),
    element("p", finding.remediation),
  );
  if (finding.location) {
    const text = `${finding.location.path}:${finding.location.line}`;
    if (finding.location.url?.startsWith("https://github.com/")) {
      const link = element("a", text, "source-link");
      link.href = finding.location.url;
      link.rel = "noreferrer";
      block.append(link);
    } else {
      block.append(element("span", text, "source-link"));
    }
  }
  return block;
}

export function evaluationRow(
  evaluation: Evaluation,
  repository: string | undefined,
  findings: ReadonlyMap<string, Finding>,
): HTMLElement {
  const status = {
    pass: ["Passed", "complete"],
    fail:
      evaluation.level === "warn"
        ? ["Warning", "warning"]
        : ["Violation", "violation"],
    error: ["Collection or evaluation error", "coverage"],
    "not-applicable": ["Not applicable", "neutral"],
  } as const;
  const [statusLabel, tone] = status[evaluation.status];
  const findingsForRow = evaluation.findingIds
    .map((id) => findings.get(id))
    .filter((finding): finding is Finding => finding !== undefined);
  const heading = element(
    findingsForRow.length ? "summary" : "div",
    "",
    "evaluation-heading",
  );
  const title = element("span", "", "evaluation-title");
  title.append(element("strong", evaluation.rule));
  if (repository)
    title.append(element("span", repository, "evaluation-repository"));
  const labels = element("span", "", "evaluation-labels");
  labels.append(
    element("span", evaluation.severity, "severity"),
    badge(statusLabel, tone),
  );
  heading.append(title, labels);
  const row = element("article", "", "evaluation");
  if (findingsForRow.length) {
    const details = element("details");
    details.append(heading, ...findingsForRow.map(findingDetails));
    row.append(details);
  } else {
    row.append(heading);
  }
  return row;
}
