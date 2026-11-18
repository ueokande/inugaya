import * as path from "node:path";
import JSON5 from "json5";
import { findNodeAtLocation, parseTree } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { LineCounter, parseDocument } from "yaml";
import { validateJsonc } from "./dependency-update-config.js";
import { EvidenceError } from "./errors.js";
import type { RepositoryFiles } from "./repository-files.js";

type Format =
  | "json"
  | "jsonc"
  | "yaml"
  | "toml"
  | "npmrc"
  | "pnpmrc"
  | "pip-ini";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function setting(data: unknown, keys: (string | number)[]): unknown {
  return keys.reduce<unknown>((value, key) => {
    if (typeof key === "number" && Array.isArray(value)) return value[key];
    const object = record(value);
    return Object.hasOwn(object, key) ? object[key] : undefined;
  }, data);
}

export function updateConfigError(file: string): EvidenceError {
  return new EvidenceError(
    "INVALID_UPDATE_CONFIG",
    `Could not evaluate the dependency waiting-period configuration in ${file}.`,
  );
}

export interface AgeSource {
  path: string;
  data: Record<string, unknown>;
  line(keys: (string | number)[]): number;
}

function iniValue(text: string): string {
  return text.trim().replace(/^(['"])(.*)\1$/, "$2");
}

// Read only the requested INI keys. Registry credentials and arbitrary
// configuration are irrelevant to these rules.
function iniSetting(
  text: string,
  name: string,
  sections = [""],
): { value: string; line: number } | undefined {
  const isPip = sections[0] === "global";
  let section = "";
  let result: { value: string; line: number } | undefined;
  let priority = -1;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1].toLowerCase();
      continue;
    }
    const entry = (
      isPip ? /^([^=:]+?)\s*[=:]\s*(.*)$/ : /^([^=]+?)\s*=\s*(.*)$/
    ).exec(line);
    const rank = sections.indexOf(section);
    const key = entry?.[1]?.trim();
    if (
      (isPip ? key?.toLowerCase() : key) === name &&
      rank >= 0 &&
      rank >= priority
    ) {
      const rawValue = entry?.[2] ?? "";
      result = {
        value: isPip
          ? rawValue.trim()
          : iniValue(rawValue.replace(/\s+[;#].*$/, "")),
        line: index + 1,
      };
      priority = rank;
    }
  }
  return result;
}

export async function releaseAgeFiles(files: RepositoryFiles) {
  const entries = new Map(
    (await files.entries()).map((entry) => [entry.path, entry]),
  );
  return {
    paths: [...entries.keys()],
    has: (name: string) => entries.has(name),
    location(name: string, line = 1) {
      const encoded = name.split("/").map(encodeURIComponent).join("/");
      return {
        path: name,
        line,
        url: `https://github.com/${files.repository}/blob/${files.commit}/${encoded}#L${line}`,
      };
    },
    async read(name: string, format: Format): Promise<AgeSource | undefined> {
      const entry = entries.get(name);
      if (!entry) return;
      const text = await files.read(entry);
      const fromOffset = (offset = 0) =>
        text.slice(0, offset).split("\n").length;
      try {
        if (format === "npmrc" || format === "pnpmrc" || format === "pip-ini") {
          const lookup = iniSetting(
            text,
            format === "pip-ini"
              ? "uploaded-prior-to"
              : format === "pnpmrc"
                ? "minimum-release-age"
                : "min-release-age",
            format === "pip-ini" ? ["global", "install"] : [""],
          );
          return {
            path: name,
            data: { age: lookup?.value },
            line: () => lookup?.line ?? 1,
          };
        }
        if (format === "yaml") {
          const counter = new LineCounter();
          const document = parseDocument(text, {
            uniqueKeys: true,
            lineCounter: counter,
          });
          if (document.errors.length) throw new Error();
          return source(
            name,
            document.toJS({ maxAliasCount: 50 }),
            (keys) => {
              const node = document.getIn(keys, true);
              const { range: offset, type } = record(node);
              return Array.isArray(offset)
                ? counter.linePos(offset[0]).line +
                    (keys.at(-1) === "run" &&
                    (type === "BLOCK_LITERAL" || type === "BLOCK_FOLDED")
                      ? 1
                      : 0)
                : 1;
            },
            true,
          );
        }
        if (format === "toml") {
          return source(name, parseToml(text), (keys) => {
            const key = keys.at(-1);
            const matches = text.split("\n").flatMap((line, index) =>
              line
                .trimStart()
                .split("=")[0]
                ?.trim()
                .replace(/^(['"])(.*)\1$/, "$2") === key
                ? [index + 1]
                : [],
            );
            return matches.length === 1 ? (matches[0] ?? 1) : 1;
          });
        }
        validateJsonc(text);
        const data: unknown =
          format === "jsonc" ? JSON5.parse(text) : JSON.parse(text);
        const tree = parseTree(text, [], { allowTrailingComma: true });
        return source(name, data, (keys) =>
          fromOffset(tree && findNodeAtLocation(tree, keys)?.offset),
        );
      } catch {
        throw updateConfigError(name);
      }
    },
    // A checked-in config explicitly referenced by a command is still read
    // from the scanned Git tree.
    configPath(value: string): string | undefined {
      if (!/^[\w./-]+$/.test(value) || path.posix.isAbsolute(value)) return;
      const normalized = path.posix.normalize(value);
      if (!normalized.startsWith("../") && entries.has(normalized))
        return normalized;
    },
  };
}

function source(
  name: string,
  data: unknown,
  line: AgeSource["line"],
  emptyMapping = false,
): AgeSource {
  if (data === null && emptyMapping) return { path: name, data: {}, line };
  if (data !== record(data)) throw new Error();
  return { path: name, data: record(data), line };
}

export type AgeFiles = Awaited<ReturnType<typeof releaseAgeFiles>>;
export interface ReleaseAgeCheck {
  location: ReturnType<AgeFiles["location"]>;
  value?: unknown;
  disabled?: boolean;
  unsupported?: boolean;
}

export function ageCheck(
  files: AgeFiles,
  config: AgeSource | undefined,
  keys: string[],
  fallback: string,
): ReleaseAgeCheck {
  return {
    value: setting(config?.data, keys),
    location: config
      ? files.location(config.path, config.line(keys))
      : files.location(fallback),
  };
}
