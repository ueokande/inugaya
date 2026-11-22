import {
  type AgeFiles,
  type AgeSource,
  ageCheck,
  type ReleaseAgeCheck,
  record,
  setting,
  updateConfigError,
} from "./release-age-files.js";
import { isWorkflowPath } from "./workflow-path.js";

const ncuConfigs = [
  ".ncurc",
  ".ncurc.json",
  ".ncurc.yaml",
  ".ncurc.yml",
  ".ncurc.js",
  ".ncurc.mjs",
  ".ncurc.cjs",
];
type CommandTool = "npm-check-updates" | "pip";

interface Invocation {
  args: string[];
  env: Record<string, unknown>;
  source: AgeSource;
  line: number;
}

function toolArgs(words: string[], tool: CommandTool): string[] | undefined {
  if (tool === "pip") {
    const launcher = /^(?:pip(?:3(?:\.\d+)?)?|python(?:3(?:\.\d+)?)?)$/;
    const command = words[0];
    if (!command || !launcher.test(command)) return;
    const tail = command.startsWith("python")
      ? words[1] === "-m" && words[2] === "pip"
        ? words.slice(3)
        : []
      : words.slice(1);
    return tail[0] === "install" ? tail.slice(1) : undefined;
  }
  const direct = /^(?:ncu|npm-check-updates)(?:@[\w.*^~+-]+)?$/;
  let index = 0;
  const command = words[0];
  if (command === "npx" || command === "bunx") index = 1;
  if (
    (command === "npm" && words[1] === "exec") ||
    ((command === "pnpm" || command === "yarn") && words[1] === "dlx")
  )
    index = 2;
  if (index > 0) {
    while (["-y", "--yes", "--"].includes(words[index] ?? "")) index += 1;
  }
  return direct.test(words[index] ?? "") ? words.slice(index + 1) : undefined;
}

// Recognize literal commands and arguments. Keep expansions as literal input
// for the rule to reject when they control the waiting period.
function invocations(
  script: string,
  source: AgeSource,
  line: number,
  tool: CommandTool,
  env: Record<string, unknown> = {},
  unsupportedContext = false,
): Invocation[] {
  const tokens =
    /\\\r?\n|#[^\n]*|\r?\n|&&|\|\||[;|&()]|(?:'[^']*'|"[^"]*"|\\[^\r\n]|[^\s;|&()'"])+/g;
  const results: Invocation[] = [];
  let words: string[] = [];
  let offset = 0;
  let cursor = 0;
  let currentLine = line;
  let changedDirectory = false;
  const flush = () => {
    const localEnv: Record<string, unknown> = { ...env };
    let index = words[0] === "env" ? 1 : 0;
    while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[index] ?? "")) {
      const word = words[index] ?? "";
      const equal = word.indexOf("=");
      const name = word.slice(0, equal);
      if (["PIP_UPLOADED_PRIOR_TO", "PIP_CONFIG_FILE"].includes(name)) {
        localEnv[name] = word.slice(equal + 1);
      }
      index += 1;
    }
    const args = toolArgs(words.slice(index), tool);
    if (args) {
      if (unsupportedContext || changedDirectory)
        throw updateConfigError(source.path);
      results.push({ args, env: localEnv, source, line: currentLine });
    }
    if (
      words[index] === "pushd" ||
      (words[index] === "cd" && ![".", "./"].includes(words[index + 1] ?? ""))
    )
      changedDirectory = true;
    words = [];
  };
  for (const match of script.matchAll(tokens)) {
    const [token] = match;
    const start = match.index ?? 0;
    if (/[^\s]/.test(script.slice(cursor, start))) {
      // An unfinished quote or an unsupported construct must not turn into
      // a valid-looking literal option.
      unsupportedContext = true;
    }
    cursor = start + token.length;
    if (/^\\\r?\n$/.test(token)) continue;
    if (/^(?:\r?\n|&&|\|\||[;|&()]|#)/.test(token)) {
      flush();
      continue;
    }
    if (words.length === 0) {
      line += script.slice(offset, start).split("\n").length - 1;
      offset = start;
      currentLine = line;
    }
    words.push(
      token.replace(
        /'([^']*)'|"([^"]*)"|\\(.)/g,
        (_all, single, double, escaped) => single ?? double ?? escaped,
      ),
    );
  }
  if (/[^\s]/.test(script.slice(cursor))) unsupportedContext = true;
  flush();
  return results;
}

function option(args: string[], ...names: string[]) {
  let value: string | undefined;
  for (const [index, arg] of args.entries()) {
    if (arg === "--") break;
    if (names.includes(arg)) {
      const next = args[index + 1];
      value = next && !next.startsWith("-") ? next : "";
    }
    const equal = arg.indexOf("=");
    if (equal !== -1 && names.includes(arg.slice(0, equal))) {
      value = arg.slice(equal + 1);
    }
  }
  return value;
}

async function readInvocations(
  files: AgeFiles,
  tool: CommandTool,
  manifest?: AgeSource,
) {
  const found: Invocation[] = [];
  if (manifest) {
    for (const [name, command] of Object.entries(
      record(manifest.data.scripts),
    )) {
      if (typeof command === "string") {
        // package.json strings may contain logical newlines. They still occupy
        // one source value, so all findings link to the script property.
        const line = manifest.line(["scripts", name]);
        found.push(
          ...invocations(command, manifest, line, tool).map((item) => ({
            ...item,
            line,
          })),
        );
      }
    }
  }
  for (const name of files.paths.filter(isWorkflowPath)) {
    const workflow = await files.read(name, "yaml");
    if (!workflow) continue;
    for (const [jobName, value] of Object.entries(record(workflow.data.jobs))) {
      const job = record(value);
      if (!Array.isArray(job.steps)) continue;
      for (const [index, item] of job.steps.entries()) {
        const step = record(item);
        if (typeof step.run !== "string") continue;
        const runKeys = ["jobs", jobName, "steps", index, "run"];
        const directory =
          step["working-directory"] ??
          setting(job, ["defaults", "run", "working-directory"]) ??
          setting(workflow.data, ["defaults", "run", "working-directory"]);
        const shell =
          step.shell ??
          setting(job, ["defaults", "run", "shell"]) ??
          setting(workflow.data, ["defaults", "run", "shell"]);
        const env = {
          ...record(workflow.data.env),
          ...record(job.env),
          ...record(step.env),
        };
        found.push(
          ...invocations(
            step.run,
            workflow,
            workflow.line(runKeys),
            tool,
            env,
            (directory !== undefined &&
              directory !== "." &&
              directory !== "./") ||
              (shell !== undefined && shell !== "bash" && shell !== "sh"),
          ),
        );
      }
    }
  }
  return found;
}

async function ncuCheck(
  files: AgeFiles,
  invocation?: Invocation,
  fallback?: AgeSource,
): Promise<ReleaseAgeCheck> {
  const args = invocation?.args ?? [];
  const configured = option(args, "--cooldown", "-c");
  if (invocation && configured !== undefined) {
    return {
      value: configured,
      location: files.location(invocation.source.path, invocation.line),
    };
  }
  const custom = option(args, "--configFileName", "--config-file-name");
  const directory =
    option(args, "--configFilePath", "--config-file-path") ?? ".";
  const names =
    custom === undefined
      ? ncuConfigs
          .map((name) => files.configPath(`${directory}/${name}`))
          .filter((name) => name !== undefined)
      : [files.configPath(`${directory}/${custom}`)];
  if (
    names.length > 1 ||
    (custom !== undefined && !names[0]) ||
    (directory !== "." && directory !== "./" && !names[0])
  ) {
    throw updateConfigError(
      invocation?.source.path ?? names.find(Boolean) ?? "package.json",
    );
  }
  const name = names[0];
  if (name && /\.[cm]?js$/.test(name)) throw updateConfigError(name);
  const config = name
    ? await files.read(name, name.endsWith(".json") ? "json" : "yaml")
    : undefined;
  const check = ageCheck(
    files,
    config,
    ["cooldown"],
    fallback?.path ?? "package.json",
  );
  if (invocation && check.value === undefined)
    check.location = files.location(invocation.source.path, invocation.line);
  return check;
}

async function pipCheck(
  files: AgeFiles,
  invocation: Invocation,
): Promise<ReleaseAgeCheck> {
  const location = files.location(invocation.source.path, invocation.line);
  const value =
    option(invocation.args, "--uploaded-prior-to") ??
    invocation.env.PIP_UPLOADED_PRIOR_TO;
  if (value !== undefined) return { value, location };
  const reference = invocation.env.PIP_CONFIG_FILE;
  if (reference === undefined || reference === "/dev/null") return { location };
  const name = typeof reference === "string" && files.configPath(reference);
  if (!name) throw updateConfigError(invocation.source.path);
  const config = await files.read(name, "pip-ini");
  return ageCheck(files, config, ["age"], invocation.source.path);
}

export async function collectCommandReleaseAge(
  files: AgeFiles,
  tool: CommandTool,
): Promise<ReleaseAgeCheck[]> {
  const manifest = await files.read("package.json", "json");
  const found = await readInvocations(files, tool, manifest);
  const checks: ReleaseAgeCheck[] = [];
  for (const invocation of found) {
    checks.push(
      tool === "pip"
        ? await pipCheck(files, invocation)
        : await ncuCheck(files, invocation),
    );
  }
  if (
    tool === "npm-check-updates" &&
    checks.length === 0 &&
    (ncuConfigs.some(files.has) ||
      ["dependencies", "devDependencies", "optionalDependencies"].some(
        (key) =>
          setting(manifest?.data, [key, "npm-check-updates"]) !== undefined,
      ))
  ) {
    checks.push(await ncuCheck(files, undefined, manifest));
  }
  return checks;
}
