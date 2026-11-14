import { planWriteAllowed } from "./plan-guard.mjs";
import { torWriteAllowed } from "./tor-guard.mjs";

const FIXTURE_ID = /^p[1-6]-[a-z0-9-]+$/;

export function resolveStageInput({ fixtureId, previousBaselineApproved }) {
  if (fixtureId != null && fixtureId !== "") {
    if (!FIXTURE_ID.test(fixtureId)) {
      throw new Error(`fixture id must look like p1-example, received ${fixtureId}`);
    }
    return {
      kind: "fixture",
      root: `fixtures/test/${fixtureId}`,
      recordBaseline: false,
      openPullRequest: false,
    };
  }
  if (!previousBaselineApproved) {
    return {
      kind: "project",
      denied: true,
      recordBaseline: false,
      openPullRequest: false,
      reason: "the previous stage has no approved baseline",
    };
  }
  return {
    kind: "project",
    denied: false,
    recordBaseline: true,
    openPullRequest: true,
  };
}

export function planStagePullRequest({
  fixture,
  validationOk,
  projectId,
  files,
  allowedDocs,
  branch,
  torGrant,
  planGrant,
}) {
  if (fixture) {
    return {
      ok: false,
      error: "Refusing to open a project pull request from a fixture. Fixtures are not baselines.",
    };
  }
  if (!validationOk) {
    return { ok: false, error: "Refusing to open a pull request while validation is not ok." };
  }
  const allowed = new Set(allowedDocs);
  const paths = [];
  for (const file of files) {
    const path = String(file.path).replace(/\\/g, "/");
    if (path.includes("fixtures/")) {
      return { ok: false, error: "Refusing to commit a fixture path." };
    }
    const planDecision = planWriteAllowed({ filePath: path, branch, grant: planGrant });
    if (planDecision.applies) {
      if (!planDecision.allowed) return { ok: false, error: planDecision.reason };
      paths.push(path);
      continue;
    }
    if (/(?:^|\/)docs\/tor\.md$/.test(path)) {
      const decision = torWriteAllowed({ filePath: path, branch, grant: torGrant });
      if (!decision.allowed) return { ok: false, error: decision.reason };
      paths.push(path);
      continue;
    }
    const prefix = `projects/${projectId}/docs/`;
    if (!path.startsWith(prefix) || !allowed.has(path.slice(prefix.length))) {
      return { ok: false, error: `Refusing to commit ${path}` };
    }
    paths.push(path);
  }
  return { ok: true, paths };
}
