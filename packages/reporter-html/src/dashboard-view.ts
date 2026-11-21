import {
  type Evaluation,
  type Finding,
  findingCounts,
  type Report,
  resourceDisplayName,
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

export function coveragePanel(
  errors: Report["errors"],
  resources: ReadonlyMap<string, { name: string }>,
): HTMLElement {
  const section = element("section", "", "coverage-panel");
  if (!errors.length) return section;
  section.append(element("h3", `Coverage errors (${errors.length})`));
  const list = element("ul", "", "coverage-list");
  for (const error of errors) {
    const item = element("li");
    item.append(
      element(
        "strong",
        [
          error.phase,
          error.resource && resourceDisplayName(error.resource, resources),
          error.rule,
          error.code,
        ]
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

function findingDetails(findings: Finding[]): HTMLElement {
  const [first] = findings;
  const block = element("div", "", "finding");
  if (!first) return block;
  block.append(
    element("p", first.message, "finding-message"),
    element("h4", "Remediation"),
    element("p", first.remediation),
  );

  const sources = findings.flatMap(({ location }) =>
    location ? [location] : [],
  );
  if (!sources.length) return block;
  const locations = element("ul", "", "finding-locations");
  sources.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const { path, line, url } of sources) {
    const item = element("li");
    const label = `${path}:${line}`;
    if (url?.startsWith("https://github.com/")) {
      const link = element("a", label, "source-link");
      link.href = url;
      link.rel = "noreferrer";
      item.append(link);
    } else {
      item.append(element("span", label));
    }
    locations.append(item);
  }
  block.append(element("h4", "Locations", "locations-heading"), locations);
  return block;
}

function findingGroups(findings: Finding[]): HTMLElement[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.message, finding.remediation]);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  return Array.from(groups.values(), findingDetails);
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
    details.append(heading, ...findingGroups(findingsForRow));
    row.append(details);
  } else {
    row.append(heading);
  }
  return row;
}
