import JSON5 from "json5";
import { visit } from "jsonc-parser";
import { parseDocument } from "yaml";
import { EvidenceError } from "./errors.js";
import type { RepositoryFiles } from "./repository-files.js";

const renovatePaths = [
  ...["renovate.json", ".github/renovate.json"].flatMap((name) => [
    name,
    `${name}c`,
    `${name}5`,
  ]),
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.jsonc",
  ".renovaterc.json5",
  "package.json",
];

const dependabotPath = ".github/dependabot.yml";

export async function collectDependencyUpdateConfig(
  files: RepositoryFiles,
  tool: "renovate" | "dependabot",
) {
  const entries = await files.entries();
  const paths = tool === "renovate" ? renovatePaths : [dependabotPath];
  const entry = paths
    .map((path) => entries.find((item) => item.path === path))
    .find((item) => item !== undefined);
  if (!entry) return null;

  const content = await files.read(entry);
  let config: unknown;
  try {
    if (tool === "dependabot") {
      const document = parseDocument(content, { uniqueKeys: true });
      if (document.errors.length) throw new Error();
      config = document.toJS({ maxAliasCount: 50 });
    } else if (entry.path === "package.json") {
      const manifest: unknown = JSON.parse(content);
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
        throw new Error();
      if (!("renovate" in manifest) || !manifest.renovate) return null;
      config =
        typeof manifest.renovate === "string"
          ? { extends: [manifest.renovate] }
          : manifest.renovate;
    } else {
      if (!entry.path.endsWith(".json5")) validateJsonc(content);
      config = JSON5.parse(content);
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error();
  } catch {
    throw new EvidenceError(
      "INVALID_UPDATE_CONFIG",
      `Could not parse ${entry.path} as a ${tool === "renovate" ? "Renovate" : "Dependabot"} configuration object.`,
    );
  }
  return {
    path: entry.path,
    url: `https://github.com/${files.repository}/blob/${files.commit}/${entry.path}`,
    config,
  };
}

function validateJsonc(content: string): void {
  const keys: Set<string>[] = [];
  visit(
    content,
    {
      onObjectBegin: () => {
        keys.push(new Set());
      },
      onObjectEnd: () => {
        keys.pop();
      },
      onObjectProperty: (name) => {
        const current = keys.at(-1);
        if (current?.has(name)) throw new Error();
        current?.add(name);
      },
      onError: () => {
        throw new Error();
      },
    },
    { allowTrailingComma: true },
  );
}
