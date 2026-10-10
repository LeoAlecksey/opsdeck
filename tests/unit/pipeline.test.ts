import { describe, expect, it } from "vitest";
import { diffPlans, evalGithubIf, evalIf, githubTriggered, globMatch, levels, parseGithub, parseGitlab, plan, type RunCtx } from "../../src/modules/pipeline";

const ctx = (p: Partial<RunCtx> = {}): RunCtx => ({ event: "push", branch: "main", defaultBranch: "main", ...p });
const status = (p: ReturnType<typeof plan>) => Object.fromEntries(p.map((x) => [x.job.name, x.status]));

describe("GitLab: include, extends, anchors, !reference", () => {
  const files = {
    ".gitlab-ci.yml": `
include:
  - local: .gitlab/tests.yml
  - project: group/templates
    file: /ci/common.yml
stages: [build, test, deploy]

.base:
  image: alpine:3.20
  before_script: [echo start]

.rules-mr: &mr
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

build:
  extends: .base
  stage: build
  script: [make]

deploy:
  <<: *mr
  stage: deploy
  when: manual
  script:
    - !reference [.base, before_script]
    - make deploy
`,
    ".gitlab/tests.yml": `
unit:
  extends: .base
  stage: test
  needs: [build]
  script: [make test]
`,
  };

  it("jobs come from every local include, templates (.name) are not jobs", () => {
    const p = parseGitlab(files);
    expect(p.jobs.map((j) => j.name).sort()).toEqual(["build", "deploy", "unit"]);
    expect(p.stages).toEqual(["build", "test", "deploy"]);
    expect(p.unresolved).toEqual(["group/templates: /ci/common.yml"]);
  });

  it("extends brings the image in, a job knows its file and line", () => {
    const p = parseGitlab(files);
    const unit = p.jobs.find((j) => j.name === "unit")!;
    expect(unit).toMatchObject({ stage: "test", image: "alpine:3.20", needs: ["build"], needsDeclared: true, file: ".gitlab/tests.yml" });
    expect(unit.line).toBe(2);
    expect(p.jobs.find((j) => j.name === "build")!.file).toBe(".gitlab-ci.yml");
  });

  it("a YAML anchor carries the rules, !reference splices the lines in", () => {
    const p = parseGitlab(files);
    const d = p.jobs.find((j) => j.name === "deploy")!;
    expect(d.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(d.when).toBe("manual");
  });

  it("a cycle in extends does not hang", () => {
    const p = parseGitlab({ ".gitlab-ci.yml": ".a:\n  extends: .b\n.b:\n  extends: .a\nx:\n  extends: .a\n  script: [echo]\n" });
    expect(p.jobs.map((j) => j.name)).toEqual(["x"]);
  });
});

describe("rules: what runs on which branch", () => {
  const p = parseGitlab({ ".gitlab-ci.yml": `
stages: [test, deploy]
test:
  stage: test
  script: [make test]
deploy-prod:
  stage: deploy
  script: [make deploy]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual
    - when: never
docs:
  stage: test
  script: [make docs]
  rules:
    - changes: ["docs/**/*", "*.md"]
legacy:
  stage: test
  script: [echo]
  only: [tags]
` });

  it("main: a prod deploy is manual, a tags-only job is skipped", () => {
    expect(status(plan(p, ctx({ branch: "main", changes: [] })))).toEqual({ test: "run", "deploy-prod": "manual", docs: "skip", legacy: "skip" });
  });

  it("a feature branch: no prod deploy at all", () => {
    const r = plan(p, ctx({ branch: "feature/x", changes: ["src/a.ts"] }));
    expect(status(r)["deploy-prod"]).toBe("skip");
    expect(r.find((x) => x.job.name === "deploy-prod")!.reason).toContain("when: never");
    // a rule that did not match at all: the job simply does not exist in the pipeline
    expect(r.find((x) => x.job.name === "docs")!.reason).toContain("ни одно правило");
  });

  it("rules:changes follow the changed files", () => {
    expect(status(plan(p, ctx({ changes: ["docs/install.md"] })))["docs"]).toBe("run");
    expect(status(plan(p, ctx({ changes: ["src/a.ts"] })))["docs"]).toBe("skip");
    // without the list of changes nothing is invented
    expect(status(plan(p, ctx()))["docs"]).toBe("unknown");
  });

  it("a tag: only:[tags] runs, the branch rule does not", () => {
    const r = status(plan(p, ctx({ event: "tag", tag: "v1.2.0", changes: [] })));
    expect(r).toMatchObject({ legacy: "run", "deploy-prod": "skip" });
  });

  it("workflow:rules can stop the whole pipeline", () => {
    const wf = parseGitlab({ ".gitlab-ci.yml": `
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - when: never
a:
  script: [x]
` });
    expect(status(plan(wf, ctx({ event: "push" })))).toEqual({ a: "skip" });
    expect(status(plan(wf, ctx({ event: "merge_request", branch: "feature/x" })))).toEqual({ a: "run" });
  });
});

describe("expressions", () => {
  const vars = { CI_COMMIT_BRANCH: "release/2.1", CI_DEFAULT_BRANCH: "main", CI_PIPELINE_SOURCE: "push", EMPTY: "" };
  it("==, !=, =~, &&, ||, parentheses", () => {
    expect(evalIf('$CI_COMMIT_BRANCH == "release/2.1"', vars)).toBe(true);
    expect(evalIf("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", vars)).toBe(false);
    expect(evalIf("$CI_COMMIT_BRANCH =~ /^release/", vars)).toBe(true);
    expect(evalIf("$CI_COMMIT_BRANCH !~ /^release/", vars)).toBe(false);
    expect(evalIf('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH =~ /^release/', vars)).toBe(true);
    expect(evalIf('($CI_COMMIT_BRANCH == "x" || $CI_COMMIT_BRANCH == "release/2.1") && $CI_PIPELINE_SOURCE == "push"', vars)).toBe(true);
    expect(evalIf("$CI_COMMIT_TAG == null", vars)).toBe(true);
    expect(evalIf("$EMPTY", vars)).toBe(false);
  });
  it("an unknown variable or an unsupported form says «unknown», not a guess", () => {
    expect(evalIf('$SECRET_FLAG == "yes"', vars)).toBe(false); // a variable that is not set is an empty string
    expect(evalIf("$SECRET_FLAG", vars)).toBe("unknown");
    expect(evalIf("semver($X)", vars)).toBe("unknown");
  });
  it("globs: ** across folders, * inside a segment, {a,b}", () => {
    expect(globMatch("docs/**/*", "docs/a/b.md")).toBe(true);
    expect(globMatch("*.md", "README.md")).toBe(true);
    expect(globMatch("*.md", "docs/README.md")).toBe(false);
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("**/*.{ts,tsx}", "src/a.tsx")).toBe(true);
  });
});

describe("GitHub Actions", () => {
  const wf = `
name: build
on:
  push:
    branches: [main, master]
    tags: ["v*"]
  pull_request:
    branches: [main]
jobs:
  checks:
    runs-on: ubuntu-24.04
    steps: [{ run: npm test }]
  tests:
    needs: checks
    strategy:
      matrix:
        os: [ubuntu-22.04, windows-2025, macos-26]
    runs-on: \${{ matrix.os }}
    steps: [{ run: cargo test }]
  publish:
    needs: [checks, tests]
    if: \${{ startsWith(github.ref, 'refs/tags/v') }}
    runs-on: ubuntu-24.04
    steps: [{ run: ./publish.sh }]
`;
  const p = parseGithub(".github/workflows/build.yml", wf);

  it("jobs, needs, matrix size and the runner", () => {
    expect(p.jobs.map((j) => j.name)).toEqual(["checks", "tests", "publish"]);
    expect(p.jobs[1]).toMatchObject({ needs: ["checks"], parallel: 3, image: "${{ matrix.os }}" });
    expect(p.jobs[2].needs).toEqual(["checks", "tests"]);
    expect(p.name).toBe("build");
  });

  it("the columns of the graph come from needs", () => {
    expect(levels(p.jobs).map((col) => col.map((j) => j.name))).toEqual([["checks"], ["tests"], ["publish"]]);
  });

  it("push to main: publish is skipped; a tag: everything runs", () => {
    expect(status(plan(p, ctx({ branch: "main" })))).toEqual({ checks: "run", tests: "run", publish: "skip" });
    expect(status(plan(p, ctx({ event: "tag", tag: "v1.0.0" })))).toEqual({ checks: "run", tests: "run", publish: "run" });
  });

  it("a branch outside on.push.branches starts nothing", () => {
    const r = plan(p, ctx({ branch: "feature/x" }));
    expect(status(r)).toEqual({ checks: "skip", tests: "skip", publish: "skip" });
    expect(r[0].reason).toContain("не подходит под branches");
  });

  it("on: paths needs the list of changed files", () => {
    const only = parseGithub("w.yml", "on:\n  push:\n    paths: ['src/**']\njobs:\n  a: { runs-on: x, steps: [] }\n");
    expect(githubTriggered(only.workflow, ctx({ changes: ["src/a.ts"] })).ok).toBe(true);
    expect(githubTriggered(only.workflow, ctx({ changes: ["README.md"] })).ok).toBe(false);
    expect(githubTriggered(only.workflow, ctx()).ok).toBe("unknown");
  });

  it("if: contains / == over github.*", () => {
    const c = ctx({ event: "merge_request", branch: "feature/x" });
    expect(evalGithubIf("${{ github.event_name == 'pull_request' }}", c)).toBe(true);
    expect(evalGithubIf("${{ contains(github.ref, 'feature') }}", ctx({ branch: "feature/x" }))).toBe(true);
    expect(evalGithubIf("${{ github.event_name == 'push' && github.ref_name == 'main' }}", ctx())).toBe(true);
    expect(evalGithubIf("${{ fromJSON(steps.x.outputs.y) }}", c)).toBe("unknown");
  });
});

describe("comparing two contexts", () => {
  it("shows which jobs appear or disappear on another branch", () => {
    const p = parseGitlab({ ".gitlab-ci.yml": `
a:
  script: [x]
deploy:
  script: [x]
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
` });
    const d = diffPlans(plan(p, ctx({ branch: "main" })), plan(p, ctx({ branch: "feature/x" })));
    expect(d).toEqual([{ name: "deploy", from: "run", to: "skip" }]);
  });
});
