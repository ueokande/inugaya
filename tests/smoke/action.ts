import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import { policyFile } from "../helpers/github-repository.ts";

const root = url.fileURLToPath(new URL("../../", import.meta.url));
for (const scenario of [
  "report",
  "violation",
  "fatal",
  "warning",
  "unpinned",
]) {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "kypa-action-smoke-"),
  );
  try {
    const migration = scenario === "warning" || scenario === "unpinned";
    await fsPromises.copyFile(
      policyFile(migration ? "migration" : "smoke"),
      path.join(directory, "kypa.yaml"),
    );

    const output = path.join(directory, "outputs");
    const summary = path.join(directory, "summary");
    await fsPromises.writeFile(output, "");
    await fsPromises.writeFile(summary, "");
    const child = childProcess.spawnSync(
      process.execPath,
      [
        "--import",
        url.fileURLToPath(new URL("./fixtures/github.ts", import.meta.url)),
        path.join(root, "dist/action/index.js"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? "",
          INPUT_TOKEN: scenario === "fatal" ? "" : "fixture-token",
          KYPA_FIXTURE_PINNING: migration ? scenario : "",
          INPUT_CONFIG: "kypa.yaml",
          "INPUT_FAIL-ON":
            scenario === "violation" || migration ? "violation" : "never",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    assert.equal(
      child.status,
      scenario === "report" || scenario === "warning" ? 0 : 1,
      child.stderr + child.stdout,
    );
    const outputs = await fsPromises.readFile(output, "utf8");
    if (scenario === "fatal") {
      assert.equal(outputs, "");
      continue;
    }
    const report = JSON.parse(
      await fsPromises.readFile(
        path.join(directory, "report/report.json"),
        "utf8",
      ),
    );
    assert.equal(report.run.status, "complete");
    assert.equal(report.findings.length, scenario === "warning" ? 1 : 2);
    assert.equal(
      report.findings.filter((item: { level: string }) => item.level === "warn")
        .length,
      migration ? 1 : 0,
    );
    assert.equal(
      report.evaluations.find(
        (item: { rule: string }) => item.rule === "actions/lockfile",
      )?.status,
      migration ? "fail" : "pass",
    );
    assert.equal(report.resources[0].metadata.scannedCommit, "a".repeat(40));
    assert.equal(
      outputs.match(/violation-count<<[^\n]+\n([0-9]+)\n/)?.[1],
      String(scenario === "warning" ? 0 : scenario === "unpinned" ? 1 : 2),
    );
    assert.equal(
      outputs.match(/warning-count<<[^\n]+\n([0-9]+)\n/)?.[1],
      String(migration ? 1 : 0),
    );
    assert.match(outputs, /complete/);
    assert.match(await fsPromises.readFile(summary, "utf8"), /Kypa scan/);
    const html = await fsPromises.readFile(
      path.join(directory, "site/index.html"),
      "utf8",
    );
    assert.match(html, /<base href="\/">/);
    assert.deepEqual(
      JSON.parse(
        await fsPromises.readFile(
          path.join(directory, "site/data.json"),
          "utf8",
        ),
      ),
      report,
    );
    assert.equal(JSON.stringify(report).includes("fixture-token"), false);
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}
console.log(
  "Bundled Action smoke checks passed: report generation, failure policy, fatal inputs, JSON and HTML assets.",
);
