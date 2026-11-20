import * as path from "node:path";
import * as url from "node:url";
import * as core from "@actions/core";
import { loadPolicy, runScan } from "@inugaya/core";
import { createGitHubProvider } from "@inugaya/provider-github";
import { createHtmlReporter } from "@inugaya/reporter-html";
import { jsonReporter } from "@inugaya/reporter-json";
import { builtInRules } from "@inugaya/rules-github";
import {
  FatalError,
  findingCounts,
  formatFailure,
  formatReportError,
  type Policy,
  type Report,
  resourceKey,
  shouldFail,
} from "@inugaya/sdk";

export interface Toolkit {
  getInput(name: string, options?: { required?: boolean }): string;

  setSecret(secret: string): void;

  setOutput(name: string, value: string | number): void;

  setFailed(message: string): void;

  warning(message: string): void;

  info(message: string): void;

  summary: {
    addHeading(text: string): unknown;
    addRaw(text: string): unknown;
    write(): Promise<unknown>;
  };
}

export interface ActionDependencies {
  load: typeof loadPolicy;
  scan: (
    policy: Policy,
    directory: string,
    digest: string,
    token: string,
    log?: (message: string) => void,
  ) => Promise<Report>;
}

const defaults: ActionDependencies = {
  load: loadPolicy,
  scan: (policy, directory, digest, token, log) =>
    runScan(policy, {
      provider: createGitHubProvider({ token, ...policy.scan }),
      rules: builtInRules,
      reporters: [
        jsonReporter,
        createHtmlReporter(
          path.resolve(
            path.dirname(url.fileURLToPath(import.meta.url)),
            "../dashboard",
          ),
        ),
      ],
      policyDirectory: directory,
      policyDigest: digest,
      ...(log ? { log } : {}),
    }),
};

export async function run(
  toolkit: Toolkit = core,
  dependencies: ActionDependencies = defaults,
): Promise<void> {
  try {
    const token = toolkit.getInput("token");
    if (!token.trim()) {
      throw new FatalError(
        "AUTHENTICATION",
        "A collection token is required.",
        [
          "The token input is empty. Pass a collection token through the Action's token input.",
        ],
      );
    }
    toolkit.setSecret(token);
    const failOn = toolkit.getInput("fail-on") || "never";
    if (failOn !== "never" && failOn !== "violation" && failOn !== "error") {
      throw new FatalError("INPUT", "Invalid fail-on input.", [
        "fail-on: Use never, violation, or error.",
      ]);
    }
    const loaded = await dependencies.load(
      toolkit.getInput("config") || "inugaya.yaml",
      builtInRules,
    );
    const report = await dependencies.scan(
      loaded.policy,
      loaded.directory,
      loaded.digest,
      token,
      (message) => toolkit.info(message.replaceAll(token, "***")),
    );
    const counts = findingCounts(report);
    toolkit.setOutput("run-id", report.run.id);
    toolkit.setOutput("status", report.run.status);
    toolkit.setOutput("violation-count", counts.violations);
    toolkit.setOutput("warning-count", counts.warnings);
    toolkit.setOutput("error-count", report.errors.length);
    toolkit.summary.addHeading("Inugaya scan");
    toolkit.summary.addRaw(
      `Status: ${report.run.status}\n\nResources: ${report.scope.evaluated}; violations: ${counts.violations}; warnings: ${counts.warnings}; errors: ${report.errors.length}\n`,
    );
    const resources = new Map(
      report.resources.map((resource) => [resourceKey(resource), resource]),
    );
    for (const error of report.errors) {
      toolkit.warning(
        formatReportError(error, resources).replaceAll(token, "***"),
      );
    }
    await toolkit.summary.write();
    if (shouldFail(report, failOn)) {
      toolkit.setFailed(
        "The generated scan report triggered the selected failure policy.",
      );
    }
  } catch (error) {
    // Never forward arbitrary exception messages, API bodies, or policy contents to workflow logs.
    toolkit.setFailed(formatFailure(error));
  }
}
