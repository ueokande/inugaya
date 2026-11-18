import type { Evidence, Rule } from "@inugaya/sdk";
import { z } from "zod";

const configFile = z
  .object({ path: z.string(), url: z.url(), config: z.unknown().nonoptional() })
  .nullable();

function readConfig(evidence: Evidence | undefined) {
  if (evidence?.state === "not-applicable") return null;
  if (evidence?.state !== "available") throw new Error("Unavailable evidence.");
  return configFile.parse(evidence.data);
}

const renovateConfig = z.object({
  enabled: z.boolean().optional(),
  minimumReleaseAge: z.unknown().optional(),
  packageRules: z
    .array(
      z.object({
        enabled: z.boolean().optional(),
        minimumReleaseAge: z.unknown().optional(),
      }),
    )
    .default([]),
});

function positiveReleaseAge(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const duration = value.trim();
  const parts =
    /\d+(?:\.\d+)?\s+(?:years?|quarters?|months?|weeks?|days?|hours?|minutes?|seconds?|milliseconds?)\b/gi;
  return (
    duration.replaceAll(parts, "").trim() === "" &&
    [...duration.matchAll(parts)].some(([part]) => Number.parseFloat(part) > 0)
  );
}

export const renovateMinimumReleaseAge: Rule = {
  id: "renovate/minimum-release-age",
  version: "1.0.0",
  resourceTypes: ["github/repository"],
  requiredEvidence: ["github/renovate-config@1"],
  defaultSeverity: "medium",
  validateParameters: (input) => z.object({}).strict().parse(input),

  evaluate(_resource, evidence) {
    const file = readConfig(evidence["github/renovate-config@1"]);
    if (!file) return { applicable: false, findings: [] };
    const config = renovateConfig.parse(file.config);
    if (config.enabled === false) return { applicable: false, findings: [] };
    const configured =
      positiveReleaseAge(config.minimumReleaseAge) ||
      config.packageRules.some(
        (rule) =>
          rule.enabled !== false && positiveReleaseAge(rule.minimumReleaseAge),
      );

    return {
      applicable: true,
      findings: configured
        ? []
        : [
            {
              key: "minimum-release-age",
              message: "Renovate has no explicit positive minimumReleaseAge.",
              remediation:
                'Set minimumReleaseAge to a positive duration, such as "3 days", in the Renovate configuration.',
              location: { path: file.path, line: 1, url: file.url },
            },
          ],
    };
  },
};

const cooldown = z.object({
  "default-days": z.unknown().optional(),
  "semver-major-days": z.unknown().optional(),
  "semver-minor-days": z.unknown().optional(),
  "semver-patch-days": z.unknown().optional(),
});
const dependabotConfig = z.object({
  version: z.literal(2),
  updates: z.array(z.object({ cooldown: z.unknown().optional() })),
});
const positiveDays = z.number().int().positive();

export const dependabotCooldown: Rule = {
  id: "dependabot/cooldown",
  version: "1.0.0",
  resourceTypes: ["github/repository"],
  requiredEvidence: ["github/dependabot-config@1"],
  defaultSeverity: "medium",
  validateParameters: (input) => z.object({}).strict().parse(input),

  evaluate(_resource, evidence) {
    const file = readConfig(evidence["github/dependabot-config@1"]);
    if (!file) return { applicable: false, findings: [] };
    const { updates } = dependabotConfig.parse(file.config);
    return {
      applicable: updates.length > 0,
      findings: updates.flatMap((update, index) => {
        const parsed = cooldown.safeParse(update.cooldown);
        if (
          parsed.success &&
          Object.values(parsed.data).some(
            (days) => positiveDays.safeParse(days).success,
          )
        ) {
          return [];
        }
        return [
          {
            key: `update-${index + 1}`,
            message: `Dependabot update entry ${index + 1} has no explicit positive cooldown.`,
            remediation:
              "Set cooldown.default-days to a positive number of days for this update entry.",
            location: { path: file.path, line: 1, url: file.url },
          },
        ];
      }),
    };
  },
};
