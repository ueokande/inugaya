import { expect, test, vi } from "vitest";
import { createGitHubProvider } from "./index.js";

const sha = "a".repeat(40);

const repository = (id = 1, overrides = {}) => ({
  id,
  full_name: `org/repo-${id}`,
  archived: false,
  fork: false,
  default_branch: "main",
  ...overrides,
});

const targets = {
  orgs: ["org"],
  repos: [],
  exclude: [],
  includeArchived: false,
  includeForks: false,
};
const settings = {
  token: "fixture-token",
  concurrency: 4,
  retries: 0,
  requestTimeoutSeconds: 30,
};

const transport =
  (route: (path: string) => unknown): typeof fetch =>
  async (input) => {
    const value = route(
      new URL(String(input)).pathname + new URL(String(input)).search,
    );
    return value instanceof Response ? value : Response.json(value);
  };

test("discovers more than 100 repositories with pagination, union deduplication, and filters", async () => {
  const request = vi.fn(
    transport((path) =>
      !path.includes("page=2")
        ? Response.json(
            Array.from({ length: 100 }, (_, i) => repository(i + 1)),
            {
              headers: {
                link: '<https://api.github.com/orgs/org/repos?type=all&per_page=100&page=2>; rel="next"',
              },
            },
          )
        : [repository(101), repository(102, { archived: true })],
    ),
  );
  const provider = createGitHubProvider({ ...settings, fetch: request });
  const result = await provider.discover({
    ...targets,
    repos: ["ORG/REPO-1"],
    exclude: ["org/repo-2"],
  });
  expect(result.resources).toHaveLength(100);
  expect(result.excluded).toEqual(["org/repo-2", "org/repo-102"]);
  expect(request).toHaveBeenCalledTimes(2);
});

test("explicit empty targets are excluded only when the branch list confirms emptiness", async () => {
  const provider = createGitHubProvider({
    ...settings,
    fetch: transport((path) => {
      if (path === "/repos/org/empty/branches?per_page=1") return [];
      return new Response("", { status: 404 });
    }),
  });
  const result = await provider.discover({
    ...targets,
    orgs: [],
    repos: ["org/empty", "org/inaccessible"],
  });
  expect(result.resources).toEqual([]);
  expect(result.notApplicable).toEqual(["org/empty"]);
  expect(result.errors).toMatchObject([
    { code: "GITHUB_404_HTTP", resource: "github/repository/org/inaccessible" },
  ]);
});

test("explicit targets have the same archive/fork filters; inaccessible targets leave coverage errors", async () => {
  const provider = createGitHubProvider({
    ...settings,
    fetch: transport((path) =>
      path.includes("missing")
        ? new Response("", { status: 404 })
        : repository(1, { fork: true }),
    ),
  });
  const result = await provider.discover({
    ...targets,
    orgs: [],
    repos: ["org/fork", "org/missing"],
  });
  expect(result.resources).toEqual([]);
  expect(result.excluded).toHaveLength(1);
  expect(result.errors).toHaveLength(1);
});

test.each([false, true])(
  "protection 404 requires established unprotected branch evidence (%s)",
  async (admin) => {
    const provider = createGitHubProvider({
      ...settings,
      fetch: transport((path) => {
        if (path.includes("/commits/")) {
          return { sha, commit: { tree: { sha } } };
        }
        if (path.endsWith("/branches/main")) {
          return { protected: !admin };
        }
        if (path.includes("/protection")) {
          return new Response("", { status: 404 });
        }
        return repository(1, { permissions: { admin } });
      }),
    });
    const resource = (
      await provider.discover({
        ...targets,
        orgs: [],
        repos: ["org/repo-1"],
      })
    ).resources[0];
    if (!resource) {
      throw new Error("Missing fixture resource");
    }
    const evidence = await provider.collect(resource, [
      "github/classic-protection@1",
    ]);
    expect(evidence["github/classic-protection@1"]?.state).toBe(
      admin ? "available" : "unavailable",
    );
  },
);

test.each([false, true])(
  "walks directory trees after a truncated recursive response (truncated child: %s)",
  async (truncated) => {
    const github = "b".repeat(40);
    const nested = "c".repeat(40);
    const blob = "d".repeat(40);
    const source =
      "runs: {using: composite, steps: [{uses: actions/checkout@v6}]}";
    const request = vi.fn(
      transport((path) => {
        const tree = "/repos/org/repo-1/git/trees";
        switch (path) {
          case "/repos/org/repo-1/commits/main":
            return { sha, commit: { tree: { sha } } };
          case `${tree}/${sha}?recursive=1`:
            return { truncated: true, tree: [] };
          case `${tree}/${sha}`:
            return {
              truncated: false,
              tree: [
                { path: ".github", sha: github, type: "tree", mode: "040000" },
                { path: "mirror", sha: github, type: "tree", mode: "040000" },
              ],
            };
          case `${tree}/${github}?recursive=1`:
            return {
              truncated,
              tree: [
                {
                  path: "nested/action.yml",
                  sha: blob,
                  type: "blob",
                  mode: "100644",
                },
              ],
            };
          case `${tree}/${github}`:
            return {
              truncated: false,
              tree: [
                {
                  path: "nested",
                  sha: nested,
                  type: "tree",
                  mode: "040000",
                },
              ],
            };
          case `${tree}/${nested}?recursive=1`:
          case `${tree}/${nested}`:
            return {
              truncated,
              tree: [
                { path: "action.yml", sha: blob, type: "blob", mode: "100644" },
              ],
            };
          case `/repos/org/repo-1/git/blobs/${blob}`:
            return {
              encoding: "base64",
              content: Buffer.from(source).toString("base64"),
              size: source.length,
            };
          case "/repos/org/repo-1":
            return repository();
          default:
            throw new Error(`Unexpected request: ${path}`);
        }
      }),
    );
    const provider = createGitHubProvider({ ...settings, fetch: request });
    const [resource] = (
      await provider.discover({ ...targets, orgs: [], repos: ["org/repo-1"] })
    ).resources;
    if (!resource) throw new Error("Missing fixture resource");

    const evidence = await provider.collect(resource, [
      "github/action-references@1",
      "github/actions-lockfile@1",
    ]);
    expect(evidence["github/action-references@1"]).toMatchObject(
      truncated
        ? { state: "unavailable", code: "TRUNCATED_TREE" }
        : {
            state: "available",
            data: {
              references: [
                {
                  path: ".github/nested/action.yml",
                  reference: "actions/checkout@v6",
                },
                {
                  path: "mirror/nested/action.yml",
                  reference: "actions/checkout@v6",
                },
              ],
            },
          },
    );
    expect(evidence["github/actions-lockfile@1"]).toMatchObject(
      truncated
        ? { state: "unavailable", code: "TRUNCATED_TREE" }
        : { state: "available", data: { lockfile: null } },
    );
    expect(request).toHaveBeenCalledTimes(truncated ? 8 : 6);
  },
);

test.each([
  { commitStatus: 409, branches: null, expected: "not-applicable" },
  { commitStatus: 404, branches: [], expected: "not-applicable" },
  { commitStatus: 404, branches: [{ name: "other" }], expected: "unavailable" },
  { commitStatus: 404, branches: 404, commits: 404, expected: "unavailable" },
  {
    commitStatus: 404,
    branches: 404,
    commits: 409,
    expected: "not-applicable",
  },
  { commitStatus: 404, branches: 401, expected: "fatal" },
])(
  "checks a missing default branch before classifying the scan ($commitStatus, $branches)",
  async ({ commitStatus, branches, commits, expected }) => {
    const fetch = vi.fn(
      transport((path) => {
        switch (path) {
          case "/repos/org/repo-1":
            return repository();
          case "/repos/org/repo-1/commits/main":
            return Response.json(
              {
                message:
                  commitStatus === 409
                    ? "Git Repository is empty."
                    : "Not Found",
              },
              { status: commitStatus },
            );
          case "/repos/org/repo-1/commits?per_page=1":
            return Response.json(
              {
                message:
                  commits === 409 ? "Git Repository is empty." : "Not Found",
              },
              { status: commits ?? 404 },
            );
          case "/repos/org/repo-1/branches?per_page=1":
            return typeof branches === "number"
              ? new Response("", { status: branches })
              : branches;
          default:
            throw new Error(`Unexpected request: ${path}`);
        }
      }),
    );
    const provider = createGitHubProvider({ ...settings, fetch });
    const [resource] = (
      await provider.discover({ ...targets, orgs: [], repos: ["org/repo-1"] })
    ).resources;
    if (!resource) throw new Error("Missing fixture resource");
    const ids = [
      "github/action-references@1",
      "github/actions-lockfile@1",
      "github/renovate-config@1",
      "github/dependabot-config@1",
    ];
    const result = provider.collect(resource, ids);
    if (expected === "fatal") {
      await expect(result).rejects.toMatchObject({ code: "AUTHENTICATION" });
    } else {
      const evidence = await result;
      for (const id of ids) {
        expect(evidence[id]).toMatchObject(
          expected === "unavailable"
            ? { state: expected, code: "GITHUB_404_HTTP" }
            : { state: expected },
        );
      }
    }
    expect(fetch).toHaveBeenCalledTimes(
      commitStatus === 409 ? 2 : branches === 404 ? 4 : 3,
    );
  },
);

test.each([403, 404, 429, 503])(
  "organization discovery explains HTTP %s without exposing response bodies",
  async (status) => {
    const provider = createGitHubProvider({
      ...settings,
      fetch: async () =>
        Response.json(
          { message: "fixture-token private response" },
          { status },
        ),
    });
    const result = await provider.discover(targets);
    expect(result.errors[0]?.code).toContain(`GITHUB_${status}_`);
    expect(result.errors[0]?.message).toContain(String(status));
    expect(JSON.stringify(result)).not.toContain("fixture-token");
    if (status === 404) {
      expect(result.errors[0]?.message).toContain("personal account");
      expect(result.errors[0]?.message).toContain("targets.repos");
    }
  },
);

test("a later discovery page failure preserves already discovered resources and missing coverage", async () => {
  const provider = createGitHubProvider({
    ...settings,
    fetch: transport((path) =>
      path.includes("page=2")
        ? new Response("", { status: 409 })
        : Response.json([repository()], {
            headers: {
              link: '<https://api.github.com/orgs/org/repos?page=2>; rel="next"',
            },
          }),
    ),
  });
  const result = await provider.discover(targets);
  expect(result.resources).toHaveLength(1);
  expect(result.errors[0]?.code).toBe("GITHUB_409_HTTP");
});

test("omitted review requirements in classic protection mean zero required reviews", async () => {
  const provider = createGitHubProvider({
    ...settings,
    fetch: transport((path) => {
      if (path.includes("/commits/")) {
        return { sha, commit: { tree: { sha } } };
      }
      if (path.endsWith("/protection")) {
        return { enforce_admins: { enabled: true } };
      }
      return repository();
    }),
  });
  const [resource] = (
    await provider.discover({ ...targets, orgs: [], repos: ["org/repo-1"] })
  ).resources;
  expect(resource).toBeDefined();
  if (!resource) {
    throw new Error("Missing fixture resource.");
  }
  const evidence = await provider.collect(resource, [
    "github/classic-protection@1",
  ]);
  expect(evidence["github/classic-protection@1"]).toMatchObject({
    state: "available",
    data: { minimum: 0 },
  });
});

test("a file error cannot hide a concurrent fatal authentication failure", async () => {
  const other = "b".repeat(40);
  const provider = createGitHubProvider({
    ...settings,
    fetch: transport((path) => {
      if (path.includes("/commits/")) {
        return { sha, commit: { tree: { sha } } };
      }
      if (path.includes("/trees/")) {
        return {
          truncated: false,
          tree: [sha, other].map((id, index) => ({
            path: `.github/workflows/${index}.yml`,
            sha: id,
            type: "blob",
            mode: "100644",
          })),
        };
      }
      if (path.includes(`/blobs/${sha}`)) {
        return new Response("private source", { status: 404 });
      }
      if (path.includes(`/blobs/${other}`)) {
        return new Response("private token", { status: 401 });
      }
      return repository();
    }),
  });
  const [resource] = (
    await provider.discover({ ...targets, orgs: [], repos: ["org/repo-1"] })
  ).resources;
  if (!resource) {
    throw new Error("Missing fixture resource.");
  }
  await expect(
    provider.collect(resource, ["github/action-references@1"]),
  ).rejects.toMatchObject({ code: "AUTHENTICATION" });
});

test("case-insensitive duplicate inaccessible targets are requested and reported once", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response("", { status: 404 }));
  const provider = createGitHubProvider({ ...settings, fetch: request });
  const result = await provider.discover({
    ...targets,
    orgs: [],
    repos: ["org/missing", "ORG/MISSING"],
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(result.errors).toHaveLength(1);
});
