import type { Rule } from "@inugaya/sdk";
import { z } from "zod";

const checks = z.array(
  z.object({
    value: z.unknown().optional(),
    disabled: z.boolean().optional(),
    unsupported: z.boolean().optional(),
    location: z.object({
      path: z.string(),
      line: z.number().int().positive(),
      url: z.url(),
    }),
  }),
);

function positiveNumber(value: unknown, allowString = false): boolean {
  const number =
    allowString &&
    typeof value === "string" &&
    /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function relative(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== "string") return false;
  const duration = value.trim();
  return pattern.test(duration) && /[1-9]/.test(duration);
}

const humanDuration =
  /^(?:\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|minutes?|seconds?|[wdhms]))(?:\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|minutes?|seconds?|[wdhms]))*$/i;
const isoDuration =
  /^P(?=\d|T)(?:\d+(?:\.\d+)?W|(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?)$/;
const ncuDuration = /^\d+[dhm]?$/i;
const pipDuration = /^P\d+D$/;
const composerDuration = /^\d+ (?:weeks?|days?|hours?|minutes?|seconds?)$/;
const miseDuration =
  /^(?:\d+(?:\.\d+)?\s*(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|mo|[ywdhms]))(?:\s*\d+(?:\.\d+)?\s*(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|mo|[ywdhms]))*$/i;

const ruleSpecs = [
  {
    tool: "npm",
    name: "min-release-age",
    valid: (value) => positiveNumber(value, true),
    example: "Set min-release-age=7 in the project .npmrc.",
  },
  {
    tool: "pnpm",
    name: "minimum-release-age",
    valid: (value, path) => positiveNumber(value, path === ".npmrc"),
    example: "Set minimumReleaseAge: 10080 in pnpm-workspace.yaml.",
  },
  {
    tool: "yarn",
    name: "minimal-age-gate",
    valid: (value) =>
      positiveNumber(value, true) || relative(value, humanDuration),
    example: "Set npmMinimalAgeGate: 7d in .yarnrc.yml.",
  },
  {
    tool: "bun",
    name: "minimum-release-age",
    valid: (value) =>
      positiveNumber(value, true) || relative(value, humanDuration),
    example: "Set install.minimumReleaseAge to 604800 in bunfig.toml.",
  },
  {
    tool: "deno",
    name: "minimum-dependency-age",
    valid: (value, path) =>
      path === ".npmrc"
        ? typeof value === "string" &&
          /^\d+$/.test(value) &&
          positiveInteger(Number(value))
        : positiveInteger(value) || relative(value, isoDuration),
    example: 'Set minimumDependencyAge to "P7D" in deno.json.',
  },
  {
    tool: "uv",
    name: "exclude-newer",
    valid: (value) =>
      relative(value, isoDuration) || relative(value, humanDuration),
    example:
      'Set exclude-newer to "7 days" in uv.toml or under tool.uv in pyproject.toml.',
  },
  {
    tool: "poetry",
    name: "min-release-age",
    valid: positiveInteger,
    example: "Set solver.min-release-age to 7 in poetry.toml.",
  },
  {
    tool: "composer",
    name: "cooldown",
    valid: (value) =>
      positiveInteger(value) || relative(value, composerDuration),
    example:
      'Set config.policy.cooldown.period to "7 days" and leave blocking enabled in composer.json.',
  },
  {
    tool: "mise",
    name: "minimum-release-age",
    valid: (value) => relative(value, miseDuration),
    example: 'Set settings.minimum_release_age to "7d" in mise.toml.',
  },
  {
    tool: "npm-check-updates",
    name: "cooldown",
    valid: (value) => positiveInteger(value) || relative(value, ncuDuration),
    example:
      "Set cooldown to 7d in the project configuration or pass --cooldown 7d.",
  },
  {
    tool: "pip",
    name: "uploaded-prior-to",
    valid: (value) => relative(value, pipDuration),
    example: "Pass --uploaded-prior-to P7D or set the equivalent pip option.",
  },
] satisfies {
  tool: string;
  name: string;
  valid(value: unknown, path: string): boolean;
  example: string;
}[];

export const toolReleaseAgeRules: readonly Rule[] = ruleSpecs.map((spec) => {
  const evidenceId = `github/${spec.tool}-release-age@1`;
  return {
    id: `${spec.tool}/${spec.name}`,
    version: "1.0.0",
    resourceTypes: ["github/repository"],
    requiredEvidence: [evidenceId],
    defaultSeverity: "medium",
    validateParameters: (input) => z.object({}).strict().parse(input),
    evaluate(_resource, evidence) {
      const item = evidence[evidenceId];
      if (item?.state === "not-applicable")
        return { applicable: false, findings: [] };
      if (item?.state !== "available") throw new Error("Unavailable evidence.");
      const targets = checks.parse(item.data);
      return {
        applicable: targets.length > 0,
        findings: targets.flatMap(
          ({ value, disabled, unsupported, location }, index) => {
            if (typeof value === "string" && /\$|\x60|\{\{/.test(value)) {
              throw new Error("Waiting period depends on a dynamic value.");
            }
            if (!unsupported && !disabled && spec.valid(value, location.path))
              return [];
            return [
              {
                key: JSON.stringify([location.path, location.line, index]),
                message: unsupported
                  ? `The declared ${spec.tool} version does not support the waiting-period setting.`
                  : `${spec.tool} has no enabled, explicit positive dependency waiting period.`,
                remediation: unsupported
                  ? `Upgrade ${spec.tool}. ${spec.example}`
                  : spec.example,
                location,
              },
            ];
          },
        ),
      };
    },
  };
});
