import {
  type Evidence,
  FatalError,
  type Provider,
  type Resource,
} from "@inugaya/sdk";
import { z } from "zod";
import { ApiError, type ClientOptions, GitHubClient } from "./client.js";
import { collectDependencyUpdateConfig } from "./dependency-update-config.js";
import { discoverTargets } from "./discovery.js";
import { GitHubDiskCache } from "./disk-cache.js";
import { describeGitHubError, EvidenceError } from "./errors.js";
import {
  collectActionLockfile,
  collectActionReferences,
  collectClassicProtection,
} from "./evidence.js";
import { createRepositoryFiles, repositoryPath } from "./repository-files.js";

import { collectToolReleaseAge, releaseAgeTool } from "./tool-release-age.js";

export { ApiError, GitHubClient } from "./client.js";

const commitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  commit: z.object({
    tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  }),
});

export function createGitHubProvider(
  options: ClientOptions & { cacheDirectory?: string },
): Provider {
  if (!options.token.trim()) {
    throw new FatalError("AUTHENTICATION", "A collection token is required.");
  }
  const api = new GitHubClient(options);
  const cache = options.cacheDirectory
    ? new GitHubDiskCache(options.cacheDirectory, options.token)
    : undefined;

  const now = () => new Date((options.now ?? Date.now)()).toISOString();

  return {
    id: "github",

    discover: (targets, signal) => discoverTargets(api, targets, signal),

    async collect(
      resource: Resource,
      ids,
      signal,
    ): Promise<Record<string, Evidence>> {
      const result: Record<string, Evidence> = {};
      const base = repositoryPath(resource.name);
      const branch = resource.metadata.defaultBranch;
      let commit: z.infer<typeof commitSchema> | undefined;

      const unavailable = (id: string, error: unknown) => {
        if (error instanceof FatalError || signal?.aborted) {
          throw error;
        }
        result[id] = {
          state: "unavailable",
          observedAt: now(),
          ...describeGitHubError(error),
        };
      };

      if (!branch) {
        for (const id of ids) {
          result[id] = { state: "not-applicable", observedAt: now() };
        }
        return result;
      }
      try {
        commit = commitSchema.parse(
          await api.get(
            `${base}/commits/${encodeURIComponent(String(branch))}`,
            signal,
          ),
        );
        resource.metadata.scannedCommit = commit.sha;
      } catch (error) {
        if (error instanceof ApiError && error.code === "EMPTY_REPOSITORY") {
          for (const id of ids) {
            result[id] = { state: "not-applicable", observedAt: now() };
          }
          return result;
        }
        for (const id of ids) {
          unavailable(id, error);
        }
        return result;
      }
      const files = createRepositoryFiles(
        api,
        {
          repository: resource.name,
          commit: commit.sha,
          tree: commit.commit.tree.sha,
        },
        options.concurrency,
        signal,
        cache?.forRepository(resource.id),
      );
      for (const id of ids) {
        try {
          let data: unknown;
          const packageTool = releaseAgeTool(id);
          if (id === "github/action-references@1") {
            data = await collectActionReferences(files, signal);
          } else if (id === "github/actions-lockfile@1") {
            data = await collectActionLockfile(files);
          } else if (id === "github/renovate-config@1") {
            data = await collectDependencyUpdateConfig(files, "renovate");
          } else if (id === "github/dependabot-config@1") {
            data = await collectDependencyUpdateConfig(files, "dependabot");
          } else if (packageTool) {
            data = await collectToolReleaseAge(files, packageTool);
          } else if (id === "github/classic-protection@1") {
            data = await collectClassicProtection(
              api,
              resource.name,
              String(branch),
              signal,
            );
          } else {
            throw new EvidenceError(
              "UNKNOWN_EVIDENCE",
              "The selected rule requests an unsupported GitHub evidence type.",
            );
          }
          result[id] = { state: "available", observedAt: now(), data };
        } catch (error) {
          unavailable(id, error);
        }
      }
      return result;
    },
  };
}
