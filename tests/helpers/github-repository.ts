import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const fixtureCommit = "a".repeat(40);
export const fixtureTree = "b".repeat(40);
export const fixtureRepository = "fixture/target";
export const fixtureToken = "fixture-token";

export function repositoryDirectory(name: string): URL {
  return new URL(`../fixtures/repositories/${name}/`, import.meta.url);
}

export function policyFile(name: string): URL {
  return new URL(`../fixtures/policies/${name}.yaml`, import.meta.url);
}

// Only the GitHub transport is synthetic. Every tree/blob comes from files on disk.
// Fixture workflows and scripts are read as data, never executed.
export function createRepositoryFixture(
  name: string,
  options: { truncatedRecursive?: boolean; truncatedDirectory?: string } = {},
): {
  fetch: typeof fetch;
  requests: string[];
} {
  type TreeEntry = { path: string; mode: string; type: string; sha: string };
  const tree: TreeEntry[] = [];
  const directories = new Map<
    string,
    { prefix: string; entries: TreeEntry[] }
  >();
  const blobs = new Map<string, Buffer>();
  const visit = (directory: URL, prefix = "") => {
    const entries: TreeEntry[] = [];
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(prefix, entry.name);
      const file = new URL(encodeURIComponent(entry.name), directory);
      if (entry.isDirectory()) {
        const sha = visit(
          new URL(`${encodeURIComponent(entry.name)}/`, directory),
          relative,
        );
        entries.push({ path: entry.name, mode: "040000", type: "tree", sha });
      } else if (entry.isFile()) {
        const content = fs.readFileSync(file);
        const sha = crypto
          .createHash("sha1")
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest("hex");
        blobs.set(sha, content);
        const gitEntry = {
          path: entry.name,
          mode: "100644",
          type: "blob",
          sha,
        };
        entries.push(gitEntry);
        tree.push({ ...gitEntry, path: relative });
      } else {
        throw new Error(`Unsupported fixture file type: ${relative}`);
      }
    }
    const sha = prefix
      ? crypto.createHash("sha1").update(JSON.stringify(entries)).digest("hex")
      : fixtureTree;
    directories.set(sha, { prefix, entries });
    return sha;
  };
  visit(repositoryDirectory(name));
  const requests: string[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      if ((init?.method ?? "GET") !== "GET")
        throw new Error("Fixture requests must be read-only.");
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com")
        throw new Error("Unexpected fixture destination.");
      if (
        new Headers(init?.headers).get("authorization") !==
        `token ${fixtureToken}`
      )
        throw new Error("Unexpected fixture authentication.");
      const request = `${url.pathname}${url.search}`;
      requests.push(request);
      const base = `/repos/${fixtureRepository}`;
      if (
        url.pathname === "/orgs/fixture-user/repos" &&
        url.searchParams.get("type") === "all" &&
        url.searchParams.get("per_page") === "100"
      )
        return Response.json({ message: "Not Found" }, { status: 404 });
      if (request === base)
        return Response.json({
          id: 42,
          full_name: fixtureRepository,
          archived: false,
          fork: false,
          default_branch: "main",
        });
      if (request === `${base}/commits/main`)
        return Response.json({
          sha: fixtureCommit,
          commit: { tree: { sha: fixtureTree } },
        });
      if (request === `${base}/git/trees/${fixtureTree}?recursive=1`)
        return Response.json(
          options.truncatedRecursive
            ? { truncated: true, tree: [] }
            : { truncated: false, tree },
        );
      if (url.pathname.startsWith(`${base}/git/trees/`) && !url.search) {
        const directory = directories.get(
          url.pathname.slice(`${base}/git/trees/`.length),
        );
        if (!directory) throw new Error("Unknown fixture directory.");
        if (directory.prefix === options.truncatedDirectory)
          return Response.json({ truncated: true, tree: [] });
        return Response.json({ truncated: false, tree: directory.entries });
      }
      if (url.pathname.startsWith(`${base}/git/blobs/`) && !url.search) {
        const content = blobs.get(
          url.pathname.slice(`${base}/git/blobs/`.length),
        );
        if (!content) throw new Error("Unknown fixture blob.");
        return Response.json({
          encoding: "base64",
          content: content.toString("base64"),
          size: content.length,
        });
      }
      if (request === `${base}/branches/main/protection`)
        return Response.json({
          required_pull_request_reviews: { required_approving_review_count: 1 },
        });
      throw new Error(`Unexpected fixture request: ${request}`);
    },
  };
}
