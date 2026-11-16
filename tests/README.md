# Tests

Run `pnpm check` from the repository root for lint, types, Vitest, all builds, and bundled Action/CLI smoke tests. `pnpm test` runs unit and integration tests without GitHub access or credentials. `pnpm build && pnpm test:smoke` checks the built entry points.

## Repository fixtures

Describe repository scenarios as files, preserving the paths that GitHub exposes:

```text
fixtures/
  repositories/
    sha-only/
      .github/workflows/ci.yml
    locked/
      .github/workflows/ci.yml
      .github/workflows/actions.lock
    composite/
      .github/workflows/ci.yml
      .github/actions/local/action.yml
  policies/
    sha.yaml
    lock.yaml
    either.yaml
    migration.yaml
  cases.json
```

Each entry in `fixtures/cases.json` selects a repository and central policy and declares expected error-level findings (`violations`), warn-level findings (`warnings`), and scan error codes. Cases can also declare exact finding `locations` (path and line) when the position distinguishes covered from uncovered uses. Add a case there when adding or changing a repository scenario. The four policy profiles cover SHA required, lockfile required, either accepted, and migration warnings. `sha-only.yaml` checks the combined rule with only the full-SHA method accepted.

`integration/repositories.test.ts` loads a real policy in a temporary directory, discovers the fixture repository through the real GitHub provider, collects/parses its files, runs the selected rules, and writes JSON and HTML reports through the real reporters. It verifies findings, source locations, coverage, exit policy, serialized reports, and request deduplication. Integration HTML assets are deliberately minimal; bundled smoke tests use the actual built dashboard assets.

`helpers/github-repository.ts` implements only the synthetic GitHub HTTP transport. It reads every file, including hidden `.github` directories, and calculates Git blob hashes from the contents. The commit and root tree IDs are fixed test identities; the lockfile's upstream commits and numeric IDs are synthetic and do not establish provenance. Unknown requests fail instead of falling through to the network. The bundled Action and CLI use this same transport and the same repository/policy fixtures.

Repository fixtures are excluded from Biome because malformed YAML, duplicate keys, and exact source locations are test inputs. Other test files and the expectations JSON remain checked. Do not run fixture workflows or install fixture dependencies. Keep fixture repositories small; protocol faults such as inaccessible APIs, truncated trees, unsupported file modes, and oversized responses remain focused provider unit tests.

Pure rule tests keep small normalized evidence objects to exercise parameter validation and evaluation boundaries. They complement file-backed tests; they do not substitute for testing collection and parsing.

Focused reference-parser tests read the `references/` fixture files directly, including invalid references and Action manifests; that directory is a collection of parser inputs, not an integration scenario. Policy schema tests use `policies/unit.yaml` with a synthetic rule and apply small mutations for individual validation boundaries. Keep protocol faults and normalized evidence boundary tests in unit tests; avoid repeating repository scenarios already covered by the integration matrix.

`fixtures/reports/dashboard.json` contains the partial report with unsafe display values and warning/error findings used by the dashboard rendering tests. Clone it before mutations so cases remain independent.
