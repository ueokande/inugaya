import { FatalError } from "@inugaya/sdk";
import { z } from "zod";
import type { GitHubClient } from "./client.js";
import type { RepositoryDiskCache } from "./disk-cache.js";
import { EvidenceError } from "./errors.js";

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
    }),
  ),
});
const blobSchema = z.object({
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
});
type TreeEntry = z.infer<typeof treeSchema>["tree"][number];
export interface RepositoryFiles {
  repository: string;
  commit: string;
  entries(): Promise<TreeEntry[]>;
  read(entry: TreeEntry): Promise<string>;
}

export function repositoryPath(name: string): string {
  return `/repos/${name.split("/").map(encodeURIComponent).join("/")}`;
}

// The cache is scoped to one resolved snapshot and one provider collection.
export function createRepositoryFiles(
  api: GitHubClient,
  snapshot: { repository: string; commit: string; tree: string },
  concurrency: number,
  signal: AbortSignal | undefined,
  cache: RepositoryDiskCache | undefined,
): RepositoryFiles {
  const base = repositoryPath(snapshot.repository);
  let entries: Promise<TreeEntry[]> | undefined;
  const blobs = new Map<string, Promise<string>>();
  return {
    repository: snapshot.repository,
    commit: snapshot.commit,
    entries() {
      entries ??= readTree(
        api,
        `${base}/git/trees`,
        snapshot.tree,
        concurrency,
        signal,
        cache,
      );
      return entries;
    },
    async read(entry) {
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
        throw new EvidenceError(
          "UNSUPPORTED_FILE",
          "A repository file is a symlink or another unsupported file type. Use regular files for complete scanning.",
        );
      }
      let content = blobs.get(entry.sha);
      if (!content) {
        content = (async () => {
          const key = `blob:${entry.sha}`;
          const cached = cache && blobSchema.safeParse(await cache.read(key));
          signal?.throwIfAborted();
          const blob =
            cached?.success && cached.data.size <= 1_048_576
              ? cached.data
              : blobSchema.parse(
                  await api.get(`${base}/git/blobs/${entry.sha}`, signal),
                );
          if (blob.size > 1_048_576)
            throw new EvidenceError(
              "FILE_TOO_LARGE",
              "A repository file exceeds the 1 MiB collection limit. File coverage is incomplete.",
            );
          if (!cached?.success || blob !== cached.data)
            await cache?.write(key, blob);
          return Buffer.from(blob.content, "base64").toString("utf8");
        })();
        blobs.set(entry.sha, content);
      }
      return content;
    },
  };
}

async function readTree(
  api: GitHubClient,
  endpoint: string,
  root: string,
  concurrency: number,
  signal: AbortSignal | undefined,
  cache: RepositoryDiskCache | undefined,
): Promise<TreeEntry[]> {
  const subtreeSchema = z.object({
    tree: treeSchema.shape.tree,
    split: z.boolean(),
  });
  async function fetchSubtree(sha: string) {
    const key = `tree:${sha}`;
    if (cache) {
      const cached = subtreeSchema.safeParse(await cache.read(key));
      signal?.throwIfAborted();
      if (cached.success) return cached.data;
    }

    const recursive = treeSchema.parse(
      await api.get(`${endpoint}/${sha}?recursive=1`, signal),
    );
    if (!recursive.truncated) {
      const subtree = { tree: recursive.tree, split: false };
      await cache?.write(key, subtree);
      return subtree;
    }

    // Split only the subtrees that exceed the recursive response limit.
    const directory = treeSchema.parse(
      await api.get(`${endpoint}/${sha}`, signal),
    );
    if (directory.truncated) {
      throw new EvidenceError(
        "TRUNCATED_TREE",
        "GitHub returned a truncated directory tree. File coverage is incomplete; the full repository tree must be readable.",
      );
    }
    const subtree = { tree: directory.tree, split: true };
    await cache?.write(key, subtree);
    return subtree;
  }

  const pending = [{ sha: root, prefix: "" }];
  const entries: TreeEntry[] = [];
  // Identical Git trees can appear at multiple paths in the same snapshot.
  const subtrees = new Map<string, ReturnType<typeof fetchSubtree>>();
  while (pending.length) {
    signal?.throwIfAborted();
    const batch = pending.splice(-concurrency);
    const results = await Promise.allSettled(
      batch.map(async ({ sha, prefix }) => {
        let subtree = subtrees.get(sha);
        if (!subtree) {
          subtree = fetchSubtree(sha);
          subtrees.set(sha, subtree);
        }
        return { ...(await subtree), prefix };
      }),
    );
    signal?.throwIfAborted();
    const fatal = results.find(
      (result) =>
        result.status === "rejected" && result.reason instanceof FatalError,
    );
    if (fatal?.status === "rejected") throw fatal.reason;

    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      const { tree, prefix, split } = result.value;
      if (!prefix && !split) return tree;
      for (const entry of tree) {
        const path = prefix + entry.path;
        entries.push({ ...entry, path });
        if (split && entry.type === "tree") {
          pending.push({ sha: entry.sha, prefix: `${path}/` });
        }
      }
    }
  }
  return entries;
}
