import { FatalError } from "@inugaya/sdk";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ApiError, type GitHubClient } from "./client.js";
import { EvidenceError } from "./errors.js";
import { type ActionReference, collectReferences } from "./references.js";
import { type RepositoryFiles, repositoryPath } from "./repository-files.js";
import { isWorkflowPath } from "./workflow-path.js";

const protectionSchema = z.object({
  required_pull_request_reviews: z
    .object({ required_approving_review_count: z.number().int().nonnegative() })
    .nullish(),
});

export async function collectActionReferences(
  files: RepositoryFiles,
  signal?: AbortSignal,
): Promise<{ references: ActionReference[] }> {
  const entries = await files.entries();
  const candidates = entries.filter(
    (entry) =>
      isWorkflowPath(entry.path) || /(^|\/)action[.]ya?ml$/.test(entry.path),
  );
  const results = await Promise.allSettled(
    candidates.map(async (entry) => {
      const content = await files.read(entry);
      try {
        return collectReferences(
          content,
          entry.path,
          files.repository,
          files.commit,
        );
      } catch (error) {
        if (error instanceof EvidenceError) {
          throw new EvidenceError(
            error.code,
            `${entry.path}: ${error.message}`,
          );
        }
        throw error;
      }
    }),
  );
  signal?.throwIfAborted();
  // A recoverable file error must not hide a concurrent authentication failure.
  const fatal = results.find(
    (result) =>
      result.status === "rejected" && result.reason instanceof FatalError,
  );
  if (fatal?.status === "rejected") {
    throw fatal.reason;
  }
  const references = results.flatMap((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
  return { references };
}

export async function collectClassicProtection(
  api: GitHubClient,
  repository: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ minimum: number }> {
  const branchPath = `${repositoryPath(repository)}/branches/${encodeURIComponent(branch)}`;
  try {
    const protection = protectionSchema.parse(
      await api.get(`${branchPath}/protection`, signal),
    );
    return {
      minimum:
        protection.required_pull_request_reviews
          ?.required_approving_review_count ?? 0,
    };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }
    // A 404 alone does not establish absence; account admin is not token access.
    const branchState = z
      .object({ protected: z.boolean() })
      .parse(await api.get(branchPath, signal));
    if (branchState.protected) {
      throw new EvidenceError(
        "PROTECTION_ACCESS",
        "Classic protection returned HTTP 404 for a protected branch. Check Administration read permission; ruleset-based protection is not evaluated by this rule.",
      );
    }
    return { minimum: 0 };
  }
}

export async function collectActionLockfile(
  files: RepositoryFiles,
): Promise<{ lockfile: unknown }> {
  const entry = (await files.entries()).find(
    (item) => item.path === ".github/workflows/actions.lock",
  );
  if (!entry) return { lockfile: null };
  const doc = parseDocument(await files.read(entry), { uniqueKeys: true });
  if (doc.errors.length) {
    throw new EvidenceError(
      "INVALID_LOCKFILE",
      "Invalid Actions lockfile YAML. Check syntax and duplicate keys.",
    );
  }
  try {
    const lockfile: unknown = doc.toJS({ maxAliasCount: 50 });
    // An empty file is invalid evidence, not an absent lockfile.
    if (lockfile === null || lockfile === undefined) throw new Error();
    return { lockfile };
  } catch {
    throw new EvidenceError(
      "INVALID_LOCKFILE",
      "The Actions lockfile is empty or its YAML aliases could not be resolved.",
    );
  }
}
