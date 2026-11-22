import type { Rule } from "@inugaya/sdk";
import { z } from "zod";
import { actionLockfileEvidence } from "./evidence.js";

export const actionsLockfile: Rule = {
  id: "actions/lockfile",
  version: "1.0.0",
  resourceTypes: ["github/repository"],
  requiredEvidence: ["github/actions-lockfile@1"],
  defaultSeverity: "high",
  validateParameters: (input) => z.object({}).strict().parse(input),
  evaluate(_resource, evidence) {
    const file = evidence["github/actions-lockfile@1"];
    if (file?.state === "not-applicable")
      return { applicable: false, findings: [] };
    if (file?.state !== "available") throw new Error("Unavailable evidence.");
    const { present, hasWorkflows } = actionLockfileEvidence.parse(file.data);
    if (!hasWorkflows) return { applicable: false, findings: [] };
    return {
      applicable: true,
      findings: present
        ? []
        : [
            {
              key: "missing-lockfile",
              message:
                "The repository has workflows but no GitHub Actions lockfile.",
              remediation:
                "Run gh actions-lock and commit .github/workflows/actions.lock.",
            },
          ],
    };
  },
};
