import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256 } from "../lib/srs-validate.mjs";
import { assessPhase3Gate, assessSrsGate, validateSrs } from "../lib/srs-validate.mjs";
import { parseSimpleYaml, setYamlPath } from "../lib/project-yaml.mjs";
import { planSrsPullRequest } from "../lib/github.mjs";
import { clearSrsReviewFlag, ensureSrsPlanFields, flagSrsForNewPlan } from "../lib/plan-yaml.mjs";
import { evaluateRecordingPullRequest } from "../lib/recording-pr.mjs";
import { recordBaseline } from "../lib/baseline.mjs";
import { renderSrsReviewNotice } from "../lib/slack-gate.mjs";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const tor = "IS-001 keep a reviewed requirements document\nOS-001 external customer access\n";
const hash = sha256(tor);

const srs = `# Introduction

A requirements document.

# Scope

In scope: the reviewed document.

# Functional Requirements

### FR-001

The product shall keep a reviewed requirements document.

Source: IS-001

# Nonfunctional Requirements

### NFR-001

The product shall keep the review with the owner.

Source: IS-001, EL-001

# Acceptance Criteria

### AC-001

The owner can read the document.

Verifies: FR-001

# Constraints and References

Text only.
`;

const project = parseSimpleYaml(`id: demo
title: Demo
status: active
tor:
  path: docs/tor.md
  status: approved
  pullRequest: 3
  branch: null
  baseline:
    mergeCommit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    approvedAt: "2026-11-14T08:00:00.000Z"
    approvedBy: "slack:T0TEAM:U0CFRUV378D"
    sha256: ${hash}
authorization:
  allowedSlackUserIds:
    - U0CFRUV378D
`);

test("SRS PR refused when tor.status none", () => {
  const none = parseSimpleYaml(setYamlPath(render(project), "tor.status", "none"));
  const gate = assessSrsGate({ project: none, torText: tor });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "tor-not-approved");
});

test("refused on hash mismatch", () => {
  const gate = assessSrsGate({ project, torText: `${tor}tampered\n` });
  assert.equal(gate.reason, "tor-hash-mismatch");
});

test("FR without IS source fails", () => {
  const result = validateSrs({
    srs: srs.replace("Source: IS-001\n", "Source: TOR 3.1\n"),
    torText: tor,
    expectedTorSha256: hash,
  });
  assert.ok(result.errors.some((error) => error.includes("FR-001 Source must cite an IS-nnn")));
});

test("unknown IS id fails", () => {
  const result = validateSrs({
    srs: srs.replace("Source: IS-001\n", "Source: IS-999\n"),
    torText: tor,
    expectedTorSha256: hash,
  });
  assert.ok(result.errors.some((error) => error.includes("unknown IS-999")));
});

test("OS reintroduction fails", () => {
  const cited = validateSrs({
    srs: srs.replace("Source: IS-001\n", "Source: OS-001\n"),
    torText: tor,
    expectedTorSha256: hash,
  });
  assert.ok(cited.errors.some((error) => error.includes("OS-001")));
  const restated = validateSrs({
    srs: srs.replace("keep a reviewed requirements document", "allow external customer access"),
    torText: tor,
    expectedTorSha256: hash,
  });
  assert.ok(restated.errors.some((error) => error.includes("reintroduces excluded OS-001")));
});

test("valid new-format SRS passes", () => {
  const gate = assessSrsGate({ project, torText: tor });
  assert.equal(gate.ok, true, gate.reason);
  const result = validateSrs({
    srs,
    torText: tor,
    expectedTorSha256: hash,
    analysis: "## Gap register\n\n- G-001 | nonblocking | resolved | none\n",
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.throws(
    () =>
      planSrsPullRequest({
        validationOk: true,
        projectId: "demo",
        files: [{ path: "projects/demo/docs/_analysis.md" }, { path: "projects/demo/docs/srs.md" }],
      }),
    /_analysis\.md/,
  );
});

test("SRS PR refused without approved projectPlan", () => {
  const gate = assessPhase3Gate({ project, torText: tor });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "projectPlan-not-approved");
});

test("SRS PR refused while plan paused by hash mismatch", () => {
  const approved = parseSimpleYaml(withPlan(render(project)));
  const gate = assessPhase3Gate({ project: approved, torText: tor, planPaused: true });
  assert.equal(gate.reason, "projectPlan-paused");
});

test("SRS baseline records sourcePlanCommit and sourcePlanSha256", () => {
  const yaml = ensureSrsPlanFields(withPlan(render(project)));
  const recorded = recordBaseline(yaml, "srs", {
    pullNumber: 4,
    mergeCommit: "b".repeat(40),
    approvedBy: "slack:T0TEAM:U0CFRUV378D",
    approvedAt: "2026-11-14T08:00:00.000Z",
    extra: {
      sha256: "ab".repeat(32),
      sourceTorCommit: "b".repeat(40),
      sourcePlanCommit: "c".repeat(40),
      sourcePlanSha256: "cd".repeat(32),
    },
  });
  const parsed = parseSimpleYaml(recorded);
  assert.equal(parsed.srs.baseline.sourcePlanCommit, "c".repeat(40));
  assert.equal(parsed.srs.baseline.sourcePlanSha256, "cd".repeat(32));
});

test("new agreed plan version flags an existing SRS for review", () => {
  const yaml = recordBaseline(ensureSrsPlanFields(withPlan(render(project))), "srs", {
    pullNumber: 4,
    mergeCommit: "b".repeat(40),
    approvedBy: "slack:T0TEAM:U0CFRUV378D",
    approvedAt: "2026-11-14T08:00:00.000Z",
    extra: { sha256: "ab".repeat(32), sourceTorCommit: "b".repeat(40), sourcePlanCommit: "c".repeat(40), sourcePlanSha256: "cd".repeat(32) },
  });
  const flagged = flagSrsForNewPlan(yaml, { newPlanCommit: "d".repeat(40), flaggedAt: "2026-11-14T09:00:00.000Z" });
  assert.equal(flagged.flagged, true);
  const parsed = parseSimpleYaml(flagged.yaml);
  assert.equal(parsed.srs.status, "needs-review");
  assert.equal(parsed.srs.review.reason, "project-plan-version-changed");
  assert.equal(parsed.srs.baseline.sha256, "ab".repeat(32));
  const notice = renderSrsReviewNotice({ projectId: "demo" });
  assert.equal(notice.blocks.some((block) => block.type === "actions"), false);
});

test("SRS tools refuse while srs.status is needs-review", () => {
  const approved = parseSimpleYaml(withPlan(render(project)));
  approved.srs = { status: "needs-review" };
  const gate = assessPhase3Gate({ project: approved, torText: tor });
  assert.equal(gate.reason, "srs-needs-review");
});

test("a new SRS approval against the new plan version clears the review flag", () => {
  const yaml = recordBaseline(ensureSrsPlanFields(withPlan(render(project))), "srs", {
    pullNumber: 4,
    mergeCommit: "b".repeat(40),
    approvedBy: "slack:T0TEAM:U0CFRUV378D",
    approvedAt: "2026-11-14T08:00:00.000Z",
    extra: { sha256: "ab".repeat(32), sourceTorCommit: "b".repeat(40), sourcePlanCommit: "c".repeat(40), sourcePlanSha256: "cd".repeat(32) },
  });
  const flagged = flagSrsForNewPlan(yaml, { newPlanCommit: "d".repeat(40), flaggedAt: "2026-11-14T09:00:00.000Z" });
  const cleared = clearSrsReviewFlag(flagged.yaml);
  const parsed = parseSimpleYaml(cleared);
  assert.equal(parsed.srs.status, "approved");
  assert.equal(parsed.srs.review.required, false);
});

test("the review-flag recording path cannot change other SRS fields", () => {
  const before = parseSimpleYaml(ensureSrsPlanFields(withPlan(render(project))));
  before.srs.review = {
    required: false,
    reason: null,
    flaggedAt: null,
    previousSourcePlanCommit: null,
    newPlanCommit: null,
  };
  const after = structuredClone(before);
  after.srs.status = "needs-review";
  after.srs.review.required = true;
  after.srs.review.reason = "project-plan-version-changed";
  after.srs.review.flaggedAt = "2026-11-14T09:00:00.000Z";
  after.srs.review.previousSourcePlanCommit = "c".repeat(40);
  after.srs.review.newPlanCommit = "d".repeat(40);
  const allowed = evaluateRecordingPullRequest({
    files: [{ path: "projects/demo/project.yaml" }],
    reference: { reviewOnly: true, document: "srs", projectId: "demo", repo: "o/r", sourcePr: 4, sourceHeadSha: "a".repeat(40), sourceMergeSha: "b".repeat(40) },
    beforeYaml: before,
    afterYaml: after,
    beforeText: "id: demo\n",
    afterText: "id: demo\n",
  });
  assert.equal(allowed.ok, true, allowed.reason);
  const dirty = structuredClone(after);
  dirty.srs.baseline.sha256 = "ff".repeat(32);
  const refused = evaluateRecordingPullRequest({
    files: [{ path: "projects/demo/project.yaml" }],
    reference: { reviewOnly: true, document: "srs", projectId: "demo", repo: "o/r", sourcePr: 4, sourceHeadSha: "a".repeat(40), sourceMergeSha: "b".repeat(40) },
    beforeYaml: before,
    afterYaml: dirty,
    beforeText: "id: demo\n",
    afterText: "id: demo\n",
  });
  assert.equal(refused.reason, "wrong field");
});

test("task-tracker-lite is refused", async () => {
  const yaml = parseSimpleYaml(await read("projects/task-tracker-lite/project.yaml"));
  const text = await read("projects/task-tracker-lite/docs/tor.md");
  const gate = assessSrsGate({ project: yaml, torText: text });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "old-format");
});

function withPlan(yaml) {
  return `${yaml.trimEnd()}
srs:
  path: docs/srs.md
  status: approved
  pullRequest: 4
  branch: null
  baseline:
    mergeCommit: ${"b".repeat(40)}
    approvedAt: "2026-11-14T08:00:00.000Z"
    approvedBy: "slack:T0TEAM:U0CFRUV378D"
    sha256: ${"ab".repeat(32)}
    sourceTorCommit: ${"b".repeat(40)}
architecture:
  path: docs/architecture.md
  status: none
  pullRequest: null
  branch: null
  baseline:
    mergeCommit: null
    approvedAt: null
    approvedBy: null
    sha256: null
    sourceSrsCommit: null
projectPlan:
  path: docs/project-plan.md
  status: approved
  pullRequest: 9
  branch: null
  baseline:
    mergeCommit: ${"c".repeat(40)}
    approvedAt: "2026-11-14T08:00:00.000Z"
    approvedBy: "slack:T0TEAM:U0CFRUV378D"
    sha256: ${"cd".repeat(32)}
    sourceTorCommit: ${"b".repeat(40)}
`;
}

function render(value) {
  return `id: ${value.id}
title: ${value.title}
status: ${value.status}
tor:
  path: ${value.tor.path}
  status: ${value.tor.status}
  pullRequest: ${value.tor.pullRequest}
  branch: null
  baseline:
    mergeCommit: ${value.tor.baseline.mergeCommit}
    approvedAt: ${JSON.stringify(value.tor.baseline.approvedAt)}
    approvedBy: ${JSON.stringify(value.tor.baseline.approvedBy)}
    sha256: ${value.tor.baseline.sha256}
authorization:
  allowedSlackUserIds:
    - U0CFRUV378D
`;
}
