import type { Rule } from "@inugaya/sdk";
import { z } from "zod";
import {
  actionLockfileEvidence,
  actionReferences,
  isFullSha,
} from "./evidence.js";

const parameters = z
  .object({
    acceptedMethods: z
      .array(z.enum(["full-sha", "lockfile"]))
      .min(1)
      .max(2)
      .refine((methods) => new Set(methods).size === methods.length)
      .default(["full-sha", "lockfile"]),
  })
  .strict();

export const pinnedDependencies: Rule = {
  id: "actions/pinned-dependencies",
  version: "2.0.0",
  resourceTypes: ["github/repository"],
  requiredEvidence: ["github/action-references@1", "github/actions-lockfile@1"],
  getRequiredEvidence: (input) =>
    parameters.parse(input).acceptedMethods.includes("lockfile")
      ? ["github/action-references@1", "github/actions-lockfile@1"]
      : ["github/action-references@1"],
  defaultSeverity: "high",
  validateParameters: (input) => parameters.parse(input),
  evaluate(_resource, evidence, input) {
    const methods = parameters.parse(input).acceptedMethods;
    const item = evidence["github/action-references@1"];
    if (item?.state === "not-applicable")
      return { applicable: false, findings: [] };
    if (item?.state !== "available") throw new Error("Unavailable evidence.");
    const refs = actionReferences.parse(item.data).references;
    if (!refs.length) return { applicable: false, findings: [] };
    const acceptSha = methods.includes("full-sha");
    const acceptLockfile = methods.includes("lockfile");
    if (acceptLockfile) {
      const file = evidence["github/actions-lockfile@1"];
      if (file?.state !== "available") throw new Error("Unavailable evidence.");
      if (actionLockfileEvidence.parse(file.data).present)
        return { applicable: true, findings: [] };
    }
    return {
      applicable: true,
      findings: refs
        .filter((ref) => !acceptSha || !isFullSha(ref.reference))
        .map((ref) => ({
          key: JSON.stringify([ref.path, ref.line, ref.reference]),
          message:
            "Remote dependency does not meet the selected pinning policy.",
          remediation:
            acceptSha && acceptLockfile
              ? "Use a reviewed full commit SHA or generate and commit a GitHub Actions lockfile with gh actions-lock."
              : acceptSha
                ? "Replace the reference with a reviewed 40-character commit SHA."
                : "Generate and commit a GitHub Actions lockfile with gh actions-lock.",
          location: { path: ref.path, line: ref.line, url: ref.url },
        })),
    };
  },
};
