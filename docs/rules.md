# Built-in rules

> Implemented built-in behavior for the unreleased first version. Only rules selected in central configuration run.

## `actions/full-sha`

| Property         | Contract                                                           |
| ---------------- | ------------------------------------------------------------------ |
| Version          | Implementation rule version `1.0.0`; no Action release exists yet. |
| Resource type    | `github/repository`                                                |
| Default severity | `high`                                                             |
| Parameters       | None                                                               |
| Required access  | Contents read for default-branch files.                            |

Require remote GitHub Action and reusable workflow references to use a 40-character hexadecimal commit SHA. Inspect workflow step `uses`, job-level reusable workflow `uses`, and `uses` inside composite `action.yml` or `action.yaml` files in the scanned repository. For example:

```yaml
steps:
  # Illustrative syntax only: replace with a reviewed existing commit.
  - uses: example-owner/example-action@0123456789abcdef0123456789abcdef01234567
```

Tags such as `@v1` and branch names such as `@main` fail this textual policy. Local `./` references and inherently pinned same-repository `$/` references are distinguished from remote `owner/repository@ref` references. An explicit remote reference back to the same repository is still remote and requires a SHA; a local path does not. A `$/` reference cannot include an explicit `@ref`. Docker references (`docker://...`) are outside this check. No relevant remote references yields `not-applicable` rather than a claimed pass.

The rule does not recursively fetch remote actions or inspect their transitive dependencies. A valid SHA string guarantees neither existence nor safety, provenance, review, or immutability of external artifacts. Parse failures and unsupported reference forms must be reported as errors rather than silently passing. Findings identify path and line and link to the scanned commit.

Central policy ignores target suppression comments. Workflow lockfiles do not satisfy a textual full-SHA requirement.

## `actions/lockfile`

| Property         | Contract                                                           |
| ---------------- | ------------------------------------------------------------------ |
| Version          | Implementation rule version `1.0.0`; no Action release exists yet. |
| Resource type    | `github/repository`                                                |
| Default severity | `high`                                                             |
| Parameters       | None                                                               |
| Required access  | Contents read for default-branch files.                            |

```yaml
rules:
  actions/lockfile: {}
```

Require a regular file at `.github/workflows/actions.lock` on the default branch of repositories with GitHub Actions workflows. This rule checks the Git tree and skips repositories without workflows. A missing file fails even when every reference is a full SHA. An incomplete or unreadable Git tree produces a collection error.

The presence check does not download or parse the lockfile, verify that a workflow or dependency is listed, or check GitHub enforcement settings. Generate and maintain the file with [gh actions-lock](https://github.com/github/gh-actions-lock). GitHub validates onboarded workflows at runtime. Use GitHub's **Require lockfile** policy to block targeted workflows that have not been onboarded.

## `actions/pinned-dependencies`

| Property         | Contract                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Version          | Implementation rule version `1.0.0`; no Action release exists yet.                           |
| Resource type    | `github/repository`                                                                          |
| Default severity | `high`                                                                                       |
| Parameter        | `acceptedMethods`: distinct nonempty list of `full-sha` and/or `lockfile`; defaults to both. |
| Required access  | Contents read for default-branch files.                                                      |

Accept either full-SHA references or a committed GitHub Actions lockfile according to `acceptedMethods`. The `full-sha` method checks each remote reference. The `lockfile` method checks file presence at the repository level, including when a reference is found in a local composite Action. A passing presence check does not verify that GitHub locks each detected reference. GitHub workflow lockfiles do not pin calls to reusable workflows.

When a selected lockfile method finds no file, the rule checks full SHAs if that method is allowed. Findings link to the noncompliant references. A SHA-only configuration skips lockfile evidence. A repository with no remote references is `not-applicable`.

## Pinning policy examples

Rule `level` controls enforcement independently of risk `severity`. It defaults to `error`. These examples apply to repositories with workflows that use remote Actions.

Require full-SHA references regardless of lockfile coverage:

```yaml
rules:
  actions/full-sha:
    level: error
```

Require a lockfile regardless of full-SHA references:

```yaml
rules:
  actions/lockfile:
    level: error
```

Accept either pinning method:

```yaml
rules:
  actions/pinned-dependencies:
    level: error
    parameters:
      acceptedMethods: [full-sha, lockfile]
```

Require pinning and recommend migrating to lockfiles:

```yaml
rules:
  actions/pinned-dependencies:
    level: error
    parameters:
      acceptedMethods: [full-sha, lockfile]
  actions/lockfile:
    level: warn
```

| Repository policy | SHA required  | Lockfile required | Either accepted | Migration                  |
| ----------------- | ------------- | ----------------- | --------------- | -------------------------- |
| SHA only          | Pass          | Error finding     | Pass            | Warning finding            |
| Lockfile only     | Error finding | Pass              | Pass            | Pass                       |
| Both              | Pass          | Pass              | Pass            | Pass                       |
| Neither           | Error finding | Error finding     | Error finding   | Error and warning findings |

Under `fail-on: violation`, warning findings alone do not fail the Action or CLI; error findings do. Independent rules retain both findings when neither protection is present. Enabling `actions/full-sha` alongside the combined rule still requires literal full-SHA references; the combined rule does not override it.

## `repository/required-reviews`

| Property         | Contract                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Resource type    | `github/repository`                                                                                                                         |
| Default severity | `medium`                                                                                                                                    |
| Parameter        | `minimum`: integer from 1 through 6, default `1`.                                                                                           |
| Evidence         | Classic protection on the default branch, observed through GitHub API.                                                                      |
| Required access  | Administration read for fine-grained PATs and sufficient account privileges; classic PAT scope and endpoint access must also be sufficient. |

```yaml
rules:
  repository/required-reviews:
    parameters:
      minimum: 2
```

Evaluate whether established classic default-branch protection requires at least `minimum` approving reviews. An empty repository without a default branch is `not-applicable`. Confirmed protection below the minimum, or confirmed absence of classic protection with established access, fails. Ambiguous access is an error; a 404 alone does not prove absence of protection.

This rule does **not** calculate effective rulesets, bypass permissions, enterprise enforcement, or the complete security posture of branch changes. A repository protected only by rulesets will not be treated as satisfying this classic-protection check; depending on available API evidence, it can produce an error or a failure even if its effective review requirements are strong. Select this rule only when this scope matches your organizational policy; do not enable it universally by default. See [authentication](authentication.md) for the distinction between token permission and account privilege.

A 404 from the classic-protection endpoint is treated as confirmed absence only when a separate readable branch response establishes `protected: false`. Account administrator status alone does not prove the token has permission to read the protection endpoint. Otherwise the result is an error. A confirmed empty-repository API response yields `not-applicable` even if repository metadata includes a default branch name.

## Dependency update waiting periods

Both rules apply to `github/repository`, default to `medium` severity, take no parameters, and require Contents read access to the default branch. Enable either rule independently:

```yaml
rules:
  renovate/minimum-release-age: {}
  dependabot/cooldown: {}
```

- `renovate/minimum-release-age` looks for a positive `minimumReleaseAge` duration, such as `"3 days"`, at the top level or in an enabled `packageRules` entry. It inspects Renovate's first standard configuration for GitHub in discovery order: root `renovate.json`, `.github/renovate.json` (each also supporting `.jsonc` and `.json5`), the `.renovaterc` variants, then the `renovate` field of `package.json`. Missing configuration or an explicitly disabled top-level configuration is `not-applicable`.
- `dependabot/cooldown` checks every version update entry in `.github/dependabot.yml` for at least one positive integer cooldown in `default-days`, `semver-major-days`, `semver-minor-days`, or `semver-patch-days`. Missing configuration or an empty update list is `not-applicable`.

These checks verify explicitly declared settings. They do not expand Renovate presets or inherited settings, calculate effective coverage across package rules or ecosystems, apply Dependabot's platform defaults, or verify waiting periods for security updates. A setting scoped to certain packages or update types can pass. Unreadable or unparseable configuration produces an error. Findings link to the configuration in the scanned commit.

### Package managers and command-line update tools

These rules inspect committed configuration and supported command forms at the repository root. Each rule applies to `github/repository`, defaults to `medium` severity, takes no parameters, and requires Contents read access. They can be enabled independently.

| Rule                          | Setting or command                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm/min-release-age`         | `.npmrc`: `min-release-age=7` (days).                                                                              |
| `pnpm/minimum-release-age`    | `pnpm-workspace.yaml`: `minimumReleaseAge: 10080` (minutes).                                                       |
| `yarn/minimal-age-gate`       | `.yarnrc.yml`: `npmMinimalAgeGate: 7d`.                                                                            |
| `bun/minimum-release-age`     | `bunfig.toml`: `install.minimumReleaseAge = 604800` (numeric seconds).                                             |
| `deno/minimum-dependency-age` | `deno.json` or `deno.jsonc`: `"minimumDependencyAge": "P7D"`.                                                      |
| `uv/exclude-newer`            | `uv.toml` or `[tool.uv]` in `pyproject.toml`: `exclude-newer = "7 days"`.                                          |
| `poetry/min-release-age`      | `poetry.toml`: `solver.min-release-age = 7` (days).                                                                |
| `composer/cooldown`           | `composer.json`: `config.policy.cooldown.period`, such as `"7 days"`.                                              |
| `mise/minimum-release-age`    | `mise.toml`: `settings.minimum_release_age = "7d"`.                                                                |
| `npm-check-updates/cooldown`  | Static `.ncurc` (JSON or YAML) or `ncu --cooldown 7d`.                                                             |
| `pip/uploaded-prior-to`       | `pip install --uploaded-prior-to P7D`, `PIP_UPLOADED_PRIOR_TO`, or an explicitly referenced repository pip config. |

A rule applies when the tool is identified by its project configuration, lockfile, package manager declaration, or a supported call site. An explicit Node package manager declaration takes precedence over another manager's lockfile alone. A Yarn lockfile alone does not distinguish Modern Yarn from Yarn Classic. A requirements file alone does not establish use of pip. The pnpm rule also supports `minimum-release-age` in `.npmrc` for a declared compatible pnpm 10 release. Deno can read `min-release-age` from `.npmrc` when its own file does not specify `minimumDependencyAge`. If both uv files exist, `uv.toml` is used without falling back to `pyproject.toml`.

The pip and npm-check-updates rules inspect literal invocations in root `package.json` scripts and GitHub Actions `run` steps. They check each supported call site. Command-line options take precedence over settings read by these rules. The pip rule reads literal environment assignments and workflow, job, and step environment declarations. If `PIP_CONFIG_FILE` points to a checked-in file, the rule checks `uploaded-prior-to` in the `[install]` or `[global]` section. Script files invoked indirectly, custom shells, and arbitrary shell control flow are outside the supported command forms. Executable npm-check-updates configuration files are never executed.

A positive relative delay passes. For applicable projects, missing, zero, or disabled settings and fixed historical dates produce findings. Dynamic settings that cannot be determined, malformed files, and unreadable configuration produce errors. Findings link to the file at the scanned commit. The rules do not rely on tool defaults, machine-wide configuration, or CI values injected at runtime. They do not verify actual resolver behavior, package-specific exceptions, or nested project configuration.
