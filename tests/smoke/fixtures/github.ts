const sha = "a".repeat(40);
const migration = process.env.KYPA_FIXTURE_PINNING;
const workflow =
  "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n";
const lockSha = "b".repeat(40);
const lockfile = `version: v0.0.3
workflows:
  .github/workflows/ci.yml: [actions/checkout@v6]
dependencies:
  actions/checkout@v6:
    ref: v6
    commit: sha1-${sha}
    owner_id: 44036562
    repo_id: 197814629
`;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.github.com") {
    throw new Error("Unexpected network destination.");
  }
  if (
    new Headers(init?.headers).get("authorization") !== "token fixture-token"
  ) {
    throw new Error("Unexpected fixture authentication.");
  }
  const path = url.pathname;
  if (path === "/orgs/fixture-user/repos") {
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  if (path === "/repos/fixture/target") {
    return Response.json({
      id: 42,
      full_name: "fixture/target",
      archived: false,
      fork: false,
      default_branch: "main",
    });
  }
  if (path === "/repos/fixture/target/commits/main") {
    return Response.json({ sha, commit: { tree: { sha } } });
  }
  if (path.startsWith("/repos/fixture/target/git/trees/")) {
    return Response.json({
      truncated: false,
      tree: [
        { path: ".github/workflows/ci.yml", mode: "100644", type: "blob", sha },
        ...(migration
          ? []
          : [
              {
                path: ".github/workflows/actions.lock",
                mode: "100644",
                type: "blob",
                sha: lockSha,
              },
            ]),
      ],
    });
  }
  if (path.startsWith("/repos/fixture/target/git/blobs/")) {
    const source = path.endsWith(lockSha)
      ? lockfile
      : migration === "warning"
        ? workflow.replace("@v6", `@${sha}`)
        : workflow;
    return Response.json({
      encoding: "base64",
      content: Buffer.from(source).toString("base64"),
      size: Buffer.byteLength(source),
    });
  }
  if (path === "/repos/fixture/target/branches/main/protection") {
    return Response.json({
      required_pull_request_reviews: { required_approving_review_count: 1 },
    });
  }
  throw new Error("Unexpected fixture endpoint.");
};
