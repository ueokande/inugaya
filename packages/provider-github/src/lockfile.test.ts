import { expect, test } from "vitest";
import { createGitHubProvider } from "./index.js";

const sha = "a".repeat(40);
async function collect(
  source: string | null,
  options: {
    truncated?: boolean;
    mode?: string;
    denied?: boolean;
    size?: number;
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
            source === null
              ? []
              : [
                  {
                    path: ".github/workflows/actions.lock",
                    type: "blob",
                    mode: options.mode ?? "100644",
                    sha,
                  },
                ],
        });
      if (options.denied) return new Response("", { status: 403 });
      return Response.json({
        encoding: "base64",
        content: Buffer.from(source ?? "").toString("base64"),
        size: options.size ?? source?.length ?? 0,
      });
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

test("collects parsed lockfile from the resolved commit tree", async () => {
  const { evidence, paths } = await collect(
    "version: v0.0.3\nworkflows: {}\ndependencies: {}\n",
  );
  expect(evidence?.state).toBe("available");
  if (evidence?.state === "available")
    expect(evidence.data).toEqual({
      lockfile: { version: "v0.0.3", workflows: {}, dependencies: {} },
    });
  expect(paths).toContain(`/repos/org/repo/git/trees/${sha}`);
  expect(paths).toContain(`/repos/org/repo/git/blobs/${sha}`);
});

test("only complete readable trees establish absence", async () => {
  const { evidence } = await collect(null);
  expect(evidence?.state === "available" && evidence.data).toEqual({
    lockfile: null,
  });
  expect((await collect(null, { truncated: true })).evidence?.state).toBe(
    "unavailable",
  );
});

test.each([
  ["version: [", {}],
  ["version: one\nversion: two", {}],
  ["", {}],
  ["version: v0.0.3", { mode: "120000" }],
  ["version: v0.0.3", { size: 1_048_577 }],
  ["version: v0.0.3", { denied: true }],
] as const)(
  "invalid or unreadable lockfiles are unavailable",
  async (source, options) => {
    expect((await collect(source, options)).evidence?.state).toBe(
      "unavailable",
    );
  },
);
