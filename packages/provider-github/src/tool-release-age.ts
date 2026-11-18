import { collectCommandReleaseAge } from "./release-age-commands.js";
import {
  type AgeFiles,
  type AgeSource,
  ageCheck,
  type ReleaseAgeCheck,
  releaseAgeFiles,
  setting,
  updateConfigError,
} from "./release-age-files.js";
import type { RepositoryFiles } from "./repository-files.js";

const nodeTools = {
  npm: {
    config: ".npmrc",
    locks: ["package-lock.json", "npm-shrinkwrap.json"],
    keys: ["age"],
  },
  pnpm: {
    config: "pnpm-workspace.yaml",
    locks: ["pnpm-lock.yaml"],
    keys: ["minimumReleaseAge"],
  },
  yarn: { config: ".yarnrc.yml", locks: [], keys: ["npmMinimalAgeGate"] },
  bun: {
    config: "bunfig.toml",
    locks: ["bun.lock", "bun.lockb"],
    keys: ["install", "minimumReleaseAge"],
  },
};
type NodeTool = keyof typeof nodeTools;

const tools = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "uv",
  "poetry",
  "composer",
  "mise",
  "npm-check-updates",
  "pip",
] as const;

export function releaseAgeTool(id: string) {
  return tools.find((tool) => id === `github/${tool}-release-age@1`);
}

function versionBefore(version: string, major: number, minor: number): boolean {
  const numbers = /^(\d+)\.(\d+)\.\d+(?:[-+][\w.+-]+)?$/.exec(version);
  return (
    !!numbers &&
    (Number(numbers[1]) < major ||
      (Number(numbers[1]) === major && Number(numbers[2]) < minor))
  );
}

async function nodeReleaseAge(
  files: AgeFiles,
  tool: NodeTool,
): Promise<ReleaseAgeCheck[]> {
  const spec = nodeTools[tool];
  const lock = spec.locks.find(files.has);
  const manifest = await files.read("package.json", "json");
  const declaration = setting(manifest?.data, ["packageManager"]);
  const declared =
    typeof declaration === "string" ? declaration.split("@") : [];
  const selected = declared[0] === tool;
  const dedicatedConfig = tool !== "npm" && files.has(spec.config);
  if (!selected && !dedicatedConfig && (!lock || declared[0])) return [];

  const version = selected ? (declared[1] ?? "") : "";
  const unsupported =
    (tool === "npm" && versionBefore(version, 11, 10)) ||
    (tool === "pnpm" && versionBefore(version, 10, 16)) ||
    (tool === "yarn" && versionBefore(version, 4, 10));
  const config = await files.read(
    spec.config,
    tool === "npm" ? "npmrc" : tool === "bun" ? "toml" : "yaml",
  );
  let check = ageCheck(files, config, spec.keys, lock ?? "package.json");
  if (tool === "pnpm" && /^10\./.test(version) && check.value === undefined) {
    const legacy = await files.read(".npmrc", "pnpmrc");
    const rc = ageCheck(files, legacy, ["age"], lock ?? "package.json");
    if (rc.value !== undefined) check = rc;
  }
  return [{ ...check, unsupported }];
}

async function denoReleaseAge(files: AgeFiles): Promise<ReleaseAgeCheck[]> {
  const names = ["deno.json", "deno.jsonc"];
  const name = names.find(files.has);
  if (!name && !files.has("deno.lock")) return [];
  const config = name && (await files.read(name, "jsonc"));
  const keys = ["minimumDependencyAge"];
  const deno = ageCheck(files, config || undefined, keys, "deno.lock");
  if (deno.value !== undefined) {
    if (deno.value !== null && typeof deno.value === "object") {
      deno.value = setting(deno.value, ["age"]) ?? null;
    }
    return [deno];
  }
  const npm = await files.read(".npmrc", "npmrc");
  const rc = ageCheck(files, npm, ["age"], "deno.lock");
  return [rc.value === undefined ? deno : rc];
}

async function pythonReleaseAge(
  files: AgeFiles,
  tool: "uv" | "poetry",
): Promise<ReleaseAgeCheck[]> {
  const lock = `${tool}.lock`;
  const manifest = await files.read("pyproject.toml", "toml");
  const configured = setting(manifest?.data, ["tool", tool]) !== undefined;
  const config = await files.read(`${tool}.toml`, "toml");
  if (!config && !configured && !files.has(lock)) return [];
  if (tool === "uv") {
    return [
      config
        ? ageCheck(files, config, ["exclude-newer"], lock)
        : ageCheck(
            files,
            configured ? manifest : undefined,
            ["tool", "uv", "exclude-newer"],
            lock,
          ),
    ];
  }
  const requirement = setting(manifest?.data, [
    "tool",
    "poetry",
    "requires-poetry",
  ]);
  const exact =
    typeof requirement === "string" ? requirement.replace(/^==?\s*/, "") : "";
  return [
    {
      ...ageCheck(
        files,
        config,
        ["solver", "min-release-age"],
        files.has(lock) ? lock : "pyproject.toml",
      ),
      unsupported: versionBefore(exact, 2, 4),
    },
  ];
}

const miseConfigs = [
  "mise.local.toml",
  ".mise.local.toml",
  ".mise.toml",
  "mise.toml",
  "mise/config.local.toml",
  "mise/config.toml",
  ".mise/config.local.toml",
  ".mise/config.toml",
  ".config/mise.toml",
  ".config/mise/mise.toml",
  ".config/mise/config.local.toml",
  ".config/mise/config.toml",
];

async function miseReleaseAge(files: AgeFiles): Promise<ReleaseAgeCheck[]> {
  const active = miseConfigs.filter(files.has);
  const other = files.paths.find(
    (name) =>
      /^(?:\.?mise|\.config\/mise)\/conf\.d\/.+\.toml$/.test(name) ||
      (/^(?:\.?mise\.[^.]+(?:\.local)?|\.config\/mise\/config\.[^.]+)\.toml$/.test(
        name,
      ) &&
        !miseConfigs.includes(name)),
  );
  if (other) throw updateConfigError(other);
  const keys = ["settings", "minimum_release_age"];
  let first: AgeSource | undefined;
  for (const name of active) {
    const config = await files.read(name, "toml");
    first ??= config;
    if (setting(config?.data, keys) !== undefined) {
      return [ageCheck(files, config, keys, "mise.lock")];
    }
  }
  if (!first && !files.has("mise.lock")) return [];
  return [ageCheck(files, first, keys, "mise.lock")];
}

export async function collectToolReleaseAge(
  snapshot: RepositoryFiles,
  tool: (typeof tools)[number],
): Promise<ReleaseAgeCheck[]> {
  const files = await releaseAgeFiles(snapshot);
  switch (tool) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return nodeReleaseAge(files, tool);
    case "deno":
      return denoReleaseAge(files);
    case "uv":
    case "poetry":
      return pythonReleaseAge(files, tool);
    case "mise":
      return miseReleaseAge(files);
    case "composer": {
      const config = await files.read("composer.json", "json");
      if (!config && !files.has("composer.lock")) return [];
      const keys = ["config", "policy", "cooldown"];
      const block = setting(config?.data, [...keys, "block"]);
      if (block !== undefined && typeof block !== "boolean") {
        throw updateConfigError("composer.json");
      }
      return [
        {
          ...ageCheck(files, config, [...keys, "period"], "composer.lock"),
          disabled: block === false,
        },
      ];
    }
    case "npm-check-updates":
    case "pip":
      return collectCommandReleaseAge(files, tool);
  }
}
