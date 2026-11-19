import { z } from "zod";
import type { GitHubClient } from "./client.js";
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
  signal?: AbortSignal,
): RepositoryFiles {
  const base = repositoryPath(snapshot.repository);
  let entries: Promise<TreeEntry[]> | undefined;
  const blobs = new Map<string, Promise<string>>();
  return {
    repository: snapshot.repository,
    commit: snapshot.commit,
    entries() {
      entries ??= readTree(api, `${base}/git/trees`, snapshot.tree, signal);
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
          const blob = blobSchema.parse(
            await api.get(`${base}/git/blobs/${entry.sha}`, signal),
          );
          if (blob.size > 1_048_576)
            throw new EvidenceError(
              "FILE_TOO_LARGE",
              "A repository file exceeds the 1 MiB collection limit. File coverage is incomplete.",
            );
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
  signal?: AbortSignal,
): Promise<TreeEntry[]> {
  const result = treeSchema.parse(
    await api.get(`${endpoint}/${root}?recursive=1`, signal),
  );
  if (!result.truncated) return result.tree;

  // Rebuild the listing from the same snapshot, discarding the partial tree.
  const entries: TreeEntry[] = [];
  async function visit(sha: string, prefix: string): Promise<void> {
    const directory = treeSchema.parse(
      await api.get(`${endpoint}/${sha}`, signal),
    );
    if (directory.truncated) {
      throw new EvidenceError(
        "TRUNCATED_TREE",
        "GitHub returned a truncated directory tree. File coverage is incomplete; the full repository tree must be readable.",
      );
    }
    for (const entry of directory.tree) {
      const path = prefix + entry.path;
      entries.push({ ...entry, path });
      if (entry.type === "tree") await visit(entry.sha, `${path}/`);
    }
  }
  await visit(root, "");
  return entries;
}
