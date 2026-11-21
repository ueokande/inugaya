import { type Report, resourceDisplayName, resourceKey } from "@inugaya/sdk";
import {
  badge,
  coveragePanel,
  element,
  evaluationRow,
  scanHeader,
} from "./dashboard-view.ts";
import "./style.css";

function searchInput(label: string, placeholder: string) {
  const container = element("label", label, "control");
  const input = element("input");
  input.type = "search";
  input.placeholder = placeholder;
  container.append(input);
  return { container, input };
}

function selectInput(label: string, values: string[]) {
  const container = element("label", label, "control");
  const input = element("select");
  for (const value of ["", ...values]) {
    const option = element("option", value || "All");
    option.value = value;
    input.append(option);
  }
  container.append(input);
  return { container, input };
}

export function renderReport(report: Report): void {
  if (report.schemaVersion !== 1) throw new Error("Unsupported report format.");

  const repositories = new Map(
    report.resources.map((resource) => [
      resourceKey(resource),
      {
        name: resource.name,
        evaluations: [] as Report["evaluations"],
        errors: [] as Report["errors"],
        attention: 0,
      },
    ]),
  );
  for (const evaluation of report.evaluations) {
    const repository = repositories.get(evaluation.resource);
    if (repository) {
      repository.evaluations.push(evaluation);
      if (needsAttention(evaluation)) repository.attention++;
    }
  }
  for (const error of report.errors) {
    if (error.resource) repositories.get(error.resource)?.errors.push(error);
  }
  const findings = new Map(
    report.findings.map((finding) => [finding.id, finding]),
  );
  const main = element("main", "", "dashboard");
  main.append(scanHeader(report));
  if (report.run.status === "partial") {
    main.append(
      element(
        "p",
        "Missing coverage: this report cannot establish compliance for all intended targets.",
        "partial-notice",
      ),
    );
  }

  const layout = element("div", "", "workspace");
  const sidebar = element("aside", "", "sidebar");
  const repositorySearch = searchInput("Find a repository", "Search by name");
  const repoHeading = element("h2", "Repositories");
  repoHeading.id = "repositories-title";
  sidebar.setAttribute("aria-labelledby", repoHeading.id);
  const repositoryList = element("ul", "", "repository-list");
  const all = element("button", "All repositories", "repository-button");
  all.type = "button";
  const showAll = element("input");
  showAll.type = "checkbox";
  const showAllLabel = element("label", "", "repository-toggle");
  showAllLabel.append(showAll, "Show repositories with no issues");
  sidebar.append(
    repoHeading,
    repositorySearch.container,
    all,
    repositoryList,
    showAllLabel,
  );

  const pane = element("section", "", "detail-pane");
  const panel = element("div", "", "detail-header");
  const title = element("h2");
  title.id = "scope-title";
  const summary = element("div", "", "scope-summary");
  panel.append(title, summary);
  pane.setAttribute("aria-labelledby", title.id);
  const coverage = element("div");
  const actions = element("div", "", "evaluation-controls");
  const attention = element("button", "", "view-button");
  const allEvaluations = element("button", "", "view-button");
  attention.type = allEvaluations.type = "button";
  const views = element("div", "", "views");
  views.append(attention, allEvaluations);

  const search = searchInput(
    "Search evaluations",
    "Search repository, rule or status",
  );
  const rule = selectInput(
    "Rule",
    [...new Set(report.evaluations.map((item) => item.rule))].sort(),
  );
  const severity = selectInput("Severity", [
    "info",
    "low",
    "medium",
    "high",
    "critical",
  ]);
  const level = selectInput("Level", ["warn", "error"]);
  const filters = element("div", "", "filters");
  filters.append(
    search.container,
    rule.container,
    severity.container,
    level.container,
  );
  actions.append(views, filters);
  const count = element("p", "", "matching-count");
  count.setAttribute("role", "status");
  const results = element("div", "", "evaluations");
  pane.append(panel, coverage, actions, count, results);
  layout.append(sidebar, pane);
  main.append(layout);
  document.body.replaceChildren(main);

  let selected: string | undefined;
  let attentionOnly = true;
  const buttons = new Map<string, HTMLButtonElement>();

  function updateResults() {
    const repository = selected ? repositories.get(selected) : undefined;
    const evaluations = repository?.evaluations ?? report.evaluations;
    const attentionCount =
      repository?.attention ?? evaluations.filter(needsAttention).length;
    attention.textContent = `Needs attention (${attentionCount})`;
    allEvaluations.textContent = `All evaluations (${evaluations.length})`;
    attention.setAttribute("aria-pressed", String(attentionOnly));
    allEvaluations.setAttribute("aria-pressed", String(!attentionOnly));
    const query = search.input.value.trim().toLowerCase();
    const rows = document.createDocumentFragment();
    let matches = 0;
    for (const item of evaluations) {
      const name = resourceDisplayName(item.resource, repositories);
      if (
        (!attentionOnly || needsAttention(item)) &&
        (!rule.input.value || item.rule === rule.input.value) &&
        (!severity.input.value || item.severity === severity.input.value) &&
        (!level.input.value || item.level === level.input.value) &&
        `${name} ${item.rule} ${item.status} ${item.level}`
          .toLowerCase()
          .includes(query)
      ) {
        rows.append(
          evaluationRow(item, repository ? undefined : name, findings),
        );
        matches++;
      }
    }
    count.textContent = `${matches} matching evaluations`;
    results.replaceChildren(rows);
    if (!matches)
      results.append(
        element("p", "No evaluations match this view.", "empty-state"),
      );
  }

  function showRepository(key?: string) {
    selected = key;
    const repository = key ? repositories.get(key) : undefined;
    title.textContent = repository?.name ?? "All repositories";
    summary.replaceChildren();
    if (repository) {
      const hasErrors =
        repository.errors.length > 0 ||
        repository.evaluations.some((item) => item.status === "error");
      summary.append(
        badge(
          hasErrors ? "Missing coverage" : "No recorded coverage errors",
          hasErrors ? "coverage" : "neutral",
        ),
      );
    } else {
      summary.append(
        element(
          "p",
          "Discovery is limited to accessible repositories. API settings and file evidence may reflect different times.",
        ),
      );
    }
    coverage.replaceChildren(
      coveragePanel(repository?.errors ?? report.errors, repositories),
    );
    all.setAttribute("aria-pressed", String(!key));
    for (const [id, button] of buttons)
      button.setAttribute("aria-pressed", String(id === key));
    updateResults();
  }

  for (const [id, repository] of repositories) {
    const item = element("li");
    const button = element("button", "", "repository-button");
    button.type = "button";
    const label = element("span", repository.name);
    button.append(label);
    if (repository.attention) {
      button.append(
        element("span", String(repository.attention), "repository-count"),
      );
    }
    button.setAttribute(
      "aria-label",
      `${repository.name}, ${repository.attention} evaluations need attention${repository.errors.length ? ", coverage gap" : ""}`,
    );
    if (repository.errors.length)
      button.append(badge("Coverage gap", "coverage"));
    button.addEventListener("click", () => showRepository(id));
    buttons.set(id, button);
    item.append(button);
    repositoryList.append(item);
  }
  const emptySearch = element("li", "", "empty-state");
  repositoryList.append(emptySearch);
  const needsReview = new Set(
    [...repositories]
      .filter(
        ([, repository]) =>
          repository.attention > 0 || repository.errors.length > 0,
      )
      .map(([id]) => id),
  );
  function updateRepositoryList() {
    const query = repositorySearch.input.value.trim().toLowerCase();
    let matches = 0;
    for (const [id, button] of buttons) {
      const visible =
        (showAll.checked || needsReview.has(id)) &&
        repositories.get(id)?.name.toLowerCase().includes(query);
      if (button.parentElement) button.parentElement.hidden = !visible;
      if (visible) matches++;
    }
    emptySearch.hidden = matches > 0;
    emptySearch.textContent =
      query || showAll.checked
        ? "No matching repositories."
        : "No repositories need attention.";
  }
  repositorySearch.input.addEventListener("input", updateRepositoryList);
  showAll.addEventListener("change", () => {
    if (!showAll.checked && selected && !needsReview.has(selected))
      showRepository();
    updateRepositoryList();
  });
  updateRepositoryList();
  all.addEventListener("click", () => showRepository());
  attention.addEventListener("click", () => {
    attentionOnly = true;
    updateResults();
  });
  allEvaluations.addEventListener("click", () => {
    attentionOnly = false;
    updateResults();
  });
  for (const control of [
    search.input,
    rule.input,
    severity.input,
    level.input,
  ]) {
    control.addEventListener("input", updateResults);
  }
  showRepository();
}

function needsAttention(evaluation: Report["evaluations"][number]): boolean {
  return evaluation.status === "fail" || evaluation.status === "error";
}

if (typeof document !== "undefined") {
  fetch(new URL("data.json", document.baseURI))
    .then((response) => {
      if (!response.ok) throw new Error("Report unavailable.");
      return response.json() as Promise<Report>;
    })
    .then(renderReport)
    .catch(() => {
      document.body.replaceChildren(
        element(
          "p",
          "The scan report could not be loaded. Check deployment artifacts and basePath.",
          "load-error",
        ),
      );
    });
}
