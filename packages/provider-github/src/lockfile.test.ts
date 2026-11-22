import { expect, test } from "vitest";
import { createGitHubProvider } from "./index.js";

const sha = "a".repeat(40);
async function collect(
  mode?: string,
  options: {
    truncated?: boolean;
  } = {},
) {
  const paths: string[] = [];
  const provider = createGitHubProvider({
    token: "fixture-token",
    concurrency: 4,
    requestTimeoutSeconds: 30,
    retries: 0,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.includes("/commits/"))
        return Response.json({ sha, commit: { tree: { sha } } });
      if (path.includes("/git/trees/"))
        return Response.json({
          truncated: options.truncated ?? false,
          tree:
            mode === undefined
              ? []
              : [
                  {
                    path: ".github/workflows/actions.lock",
                    type: "blob",
                    mode,
                    sha,
                  },
                ],
        });
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  const resource = {
    provider: "github",
    type: "repository",
    id: "1",
    name: "org/repo",
    url: "https://github.com/org/repo",
    metadata: { defaultBranch: "main" },
  };
  const result = await provider.collect(resource, [
    "github/actions-lockfile@1",
  ]);
  return { evidence: result["github/actions-lockfile@1"], paths };
}

test.each([
  ["100644", true],
  ["100755", true],
  ["120000", false],
  [undefined, false],
] as const)(
  "checks the commit tree without downloading the lockfile (mode %s)",
  async (mode, present) => {
    const { evidence, paths } = await collect(mode);
    expect(evidence).toMatchObject({ state: "available", data: { present } });
    expect(paths).toEqual([
      "/repos/org/repo/commits/main",
      `/repos/org/repo/git/trees/${sha}`,
    ]);
  },
);

test("only complete readable trees establish absence", async () => {
  expect((await collect(undefined, { truncated: true })).evidence?.state).toBe(
    "unavailable",
  );
});
