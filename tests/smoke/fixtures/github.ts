import { createRepositoryFixture } from "../../helpers/github-repository.ts";

const scenario = process.env.KYPA_FIXTURE_PINNING;
const repository =
  scenario === "warning"
    ? "sha-only"
    : scenario === "unpinned"
      ? "unpinned"
      : "locked";
globalThis.fetch = createRepositoryFixture(repository).fetch;
