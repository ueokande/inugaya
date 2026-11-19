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
  entryAt(path: string): Promise<TreeEntry | undefined>;
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
  let indexed: TreeEntry[] | undefined;
  const directories = new Map<string, Promise<TreeEntry[]>>();
  const blobs = new Map<string, Promise<string>>();

  function directory(sha: string): Promise<TreeEntry[]> {
    let pending = directories.get(sha);
    if (!pending) {
      pending = (async () => {
        const result = treeSchema.parse(
          await api.get(`${base}/git/trees/${sha}`, signal),
        );
        if (result.truncated) {
          throw new EvidenceError(
            "TRUNCATED_TREE",
            "GitHub returned a truncated directory tree. The required directory could not be read completely.",
          );
        }
        return result.tree;
      })();
      directories.set(sha, pending);
    }
    return pending;
  }

  async function walk(sha: string, prefix: string, result: TreeEntry[]) {
    signal?.throwIfAborted();
    for (const entry of await directory(sha)) {
      const path = prefix + entry.path;
      result.push({ ...entry, path });
      if (entry.type === "tree") {
        await walk(entry.sha, `${path}/`, result);
      }
    }
  }

  return {
    repository: snapshot.repository,
    commit: snapshot.commit,
    entries() {
      entries ??= (async () => {
        const result = treeSchema.parse(
          await api.get(
            `${base}/git/trees/${snapshot.tree}?recursive=1`,
            signal,
          ),
        );
        if (!result.truncated) {
          indexed = result.tree;
        } else {
          // A truncated recursive response can omit files anywhere in the
          // repository. Rebuild the index from complete individual trees.
          const complete: TreeEntry[] = [];
          await walk(snapshot.tree, "", complete);
          indexed = complete;
        }
        return indexed;
      })();
      return entries;
    },
    async entryAt(path) {
      if (indexed) return indexed.find((entry) => entry.path === path);

      const components = path.split("/");
      const filename = components.pop();
      let sha = snapshot.tree;
      for (const component of components) {
        const entry = (await directory(sha)).find(
          (item) => item.path === component,
        );
        if (!entry) return undefined;
        if (entry.type !== "tree") {
          throw new EvidenceError(
            "UNSUPPORTED_FILE",
            "A parent directory of the required file is an unsupported Git entry.",
          );
        }
        sha = entry.sha;
      }
      const entry = (await directory(sha)).find(
        (item) => item.path === filename,
      );
      return entry && { ...entry, path };
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
