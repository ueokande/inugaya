import type { Rule } from "@inugaya/sdk";
import { z } from "zod";
import { actionReferences, isFullSha } from "./evidence.js";
import { isLockfileReference, lockfileCoverage } from "./lockfile.js";

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
  version: "1.0.0",
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
    let covered: ReturnType<typeof lockfileCoverage> = () => false;
    if (methods.includes("lockfile")) {
      const file = evidence["github/actions-lockfile@1"];
      if (file?.state !== "available") throw new Error("Unavailable evidence.");
      const { lockfile } = z
        .object({ lockfile: z.unknown().nonoptional().nullable() })
        .parse(file.data);
      // A corrupt lockfile is an evaluation error even when all uses are SHAs.
      covered = lockfileCoverage(lockfile);
    }
    return {
      applicable: true,
      findings: refs
        .filter(
          (ref) =>
            !(methods.includes("full-sha") && isFullSha(ref.reference)) &&
            !(
              methods.includes("lockfile") &&
              isLockfileReference(ref) &&
              covered(ref)
            ),
        )
        .map((ref) => ({
          key: JSON.stringify([ref.path, ref.line, ref.reference]),
          message: "Remote dependency is not pinned by any accepted method.",
          remediation:
            methods.includes("full-sha") && methods.includes("lockfile")
              ? "Use a reviewed full commit SHA or generate and commit a covering GitHub Actions lockfile with gh actions-lock."
              : methods.includes("full-sha")
                ? "Replace the reference with a reviewed 40-character commit SHA."
                : "Generate and commit a covering GitHub Actions lockfile with gh actions-lock; references outside native lockfile coverage cannot satisfy this policy.",
          location: { path: ref.path, line: ref.line, url: ref.url },
        })),
    };
  },
};
