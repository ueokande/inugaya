import type { Rule } from "@kypa/sdk";
import { z } from "zod";
import { actionReferences } from "./evidence.js";

const pin = z.string().regex(/^[^/@:\s]+\/[^/@:\s]+@[^:\s]+$/);
const dependency = z
  .object({
    hostname: z.literal("github.com").optional(),
    ref: z.string().min(1),
    commit: z.string().regex(/^sha1-[a-f0-9]{40}$/),
    owner_id: z.number().int().positive(),
    repo_id: z.number().int().positive(),
    uses: z.array(pin).optional(),
  })
  .strict();
const lockSchema = z
  .object({
    version: z.literal("v0.0.3"),
    workflows: z.record(z.string(), z.array(pin)).default({}),
    dependencies: z.record(pin, dependency).default({}),
  })
  .strict();

const identity = (value: string) => {
  const at = value.indexOf("@");
  const repository = value
    .slice(0, at)
    .split("/")
    .slice(0, 2)
    .join("/")
    .toLowerCase();
  const ref = value.slice(at + 1);
  return `${repository}@${/^[a-fA-F0-9]{40}$/.test(ref) ? ref.toLowerCase() : ref}`;
};

export const actionsLockfile: Rule = {
  id: "actions/lockfile",
  version: "1.0.0",
  resourceTypes: ["github/repository"],
  requiredEvidence: ["github/action-references@1", "github/actions-lockfile@1"],
  defaultSeverity: "high",
  validateParameters: (input) => z.object({}).strict().parse(input),
  evaluate(_resource, evidence) {
    const references = evidence["github/action-references@1"];
    const file = evidence["github/actions-lockfile@1"];
    if (
      references?.state === "not-applicable" &&
      file?.state === "not-applicable"
    ) {
      return { applicable: false, findings: [] };
    }
    if (references?.state !== "available" || file?.state !== "available") {
      throw new Error("Unavailable evidence.");
    }
    // Native lockfiles cover workflow Actions, not remote reusable workflows
    // or standalone composite manifests in the scanned repository.
    const refs = actionReferences
      .parse(references.data)
      .references.filter(
        (ref) =>
          /^\.github\/workflows\/[^/]+\.ya?ml$/.test(ref.path) &&
          !/^[^/]+\/[^/]+\/\.github\/workflows\//.test(ref.reference),
      );
    if (!refs.length) return { applicable: false, findings: [] };
    const { lockfile } = z
      .object({ lockfile: z.unknown().nonoptional().nullable() })
      .parse(file.data);
    const remediation =
      "Run gh actions-lock, review the result, and commit .github/workflows/actions.lock with the workflows.";
    if (lockfile === null) {
      return {
        applicable: true,
        findings: [
          {
            key: "missing-lockfile",
            message: "Workflow Actions have no GitHub Actions lockfile.",
            remediation,
          },
        ],
      };
    }
    const lock = lockSchema.parse(lockfile);
    const entries = new Map(
      Object.entries(lock.dependencies).map(([key, value]) => [
        identity(key),
        value,
      ]),
    );
    if (entries.size !== Object.keys(lock.dependencies).length)
      throw new Error("Duplicate canonical lockfile pins.");
    const findings = refs
      .filter((ref) => {
        const listed = lock.workflows[ref.path] ?? [];
        const roots = listed.filter((key) => {
          if (identity(key) === identity(ref.reference)) return true;
          const entry = entries.get(identity(key));
          return (
            entry !== undefined &&
            identity(`${key.split("@")[0]}@${entry.commit.slice(5)}`) ===
              identity(ref.reference)
          );
        });
        if (!roots.length) return true;
        const covered = new Set(listed.map(identity));
        const visited = new Set<string>();
        const pending = [...roots];
        while (pending.length) {
          const key = identity(pending.pop() as string);
          if (visited.has(key)) continue;
          visited.add(key);
          const entry = entries.get(key);
          if (!entry || !covered.has(key)) return true;
          const keyRef = key.slice(key.indexOf("@") + 1);
          if (
            /^[a-f0-9]{40}$/.test(keyRef)
              ? entry.commit !== `sha1-${keyRef}`
              : entry.ref !== keyRef
          )
            return true;
          if (
            /^[a-fA-F0-9]{40}$/.test(entry.ref) ||
            entry.ref.startsWith("refs/")
          )
            return true;
          pending.push(...(entry.uses ?? []));
        }
        return false;
      })
      .map((ref) => ({
        key: JSON.stringify([ref.path, ref.line, ref.reference]),
        message:
          "Workflow Action or its recorded dependency graph is not covered by the Actions lockfile.",
        remediation,
        location: { path: ref.path, line: ref.line, url: ref.url },
      }));
    return { applicable: true, findings };
  },
};
