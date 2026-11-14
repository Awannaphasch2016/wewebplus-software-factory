import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateProjectPlan } from "../lib/project-plan-validate.mjs";

const root = new URL("..", import.meta.url);
const TOR = [
  "## 3.1 In Scope",
  "- IS-001 Publish a weekly note",
  "- IS-002 Record the decision",
  "## 3.2 Out of Scope",
  "- OS-001 External customer billing stays outside this work",
].join("\n");

const WAYS = [
  "We use a weekly Specification → Research → Prototype cycle.",
  "We complete at least one complete cycle per week.",
  "Evidence is evidence referenced from the Design Prototype.",
  "The end-of-cycle two questions use a requirements-gap route and a design-gap route.",
  "The TOR is never changed. A change to the TOR means a new project.",
].join("\n");

function plan(overrides = {}) {
  const sections = {
    "1. About this plan": [
      "**Status:** draft",
      "",
      "### Version history",
      "",
      "| Version | Date | Agreed by (team) | What changed |",
      "| --- | --- | --- | --- |",
      "| 1 | 2026-11-14 | delivery team | First plan |",
    ].join("\n"),
    "2. Scope": "- **In scope:** IS-001, IS-002\n- **Out of scope:** OS-001",
    "3. How we will work together": WAYS,
    "4. Planned work": [
      "| Cycle | Week starting | Scope (IS-nnn) | Specification aim | Research question | Prototype aim |",
      "| --- | --- | --- | --- | --- | --- |",
      "| I-001 | 2026-11-16 | IS-001, IS-002 | Write the note | Which format | A one-page sample |",
    ].join("\n"),
    "5. Economic evaluation": [
      "| Cycle | Scope (IS-nnn) | Work required | Suggested duration (optional, marked as suggestion) | Final person-days (human) |",
      "| --- | --- | --- | --- | --- |",
      "| I-001 | IS-001 | Draft the note | 2 days suggestion | 3 |",
      "",
      "- Day rate and currency: to be agreed",
      "- Name: Anak",
      "- Date: 2026-11-14",
    ].join("\n"),
    "6. Risks": [
      "| ID | Risk | Internal or external | Scope affected | What we will do | Owner |",
      "| --- | --- | --- | --- | --- | --- |",
      "| R-001 | A week slips | internal | IS-001 | Replan the next week | delivery lead |",
    ].join("\n"),
    "7. Documents we will produce": [
      "| Document | What it is for | Standard / reference | Status |",
      "| --- | --- | --- | --- |",
      "| Terms of Reference | Agreed scope | WP-PS-SOW-01, A2-01 | agreed |",
      "| This project plan | Working arrangements | WP-PS-PLAN-xx | draft |",
      "| Requirements specification | What will be built | SRS | not yet |",
      "| Design and Design Prototype | Evidence | WP-SA-PT-01 | not yet |",
    ].join("\n"),
    ...overrides,
  };
  return Object.entries(sections).map(([title, body]) => `## ${title}\n\n${body}`).join("\n\n");
}

const PEL = [
  "## PEL-001",
  "- field: s5.work.I-001.final",
  "- value: 3",
  "- responder: slack:T0TEAM:U0CFRUV378D",
  "- timestamp: 2026-11-14T01:00:00.000Z",
  "- resolution: approved",
].join("\n");

function errorsOf(overrides, log = PEL, tor = TOR) {
  return validateProjectPlan({ plan: plan(overrides), tor, elicitationLog: log }).errors;
}

test("each plan fixture matches its expected error set", async () => {
  for (const name of [
    "p2-plan-empty",
    "p2-plan-partial",
    "p2-plan-os-reintroduced",
    "p2-plan-uncovered-is",
    "p2-plan-figures-unlogged",
    "p2-plan-complete",
  ]) {
    const dir = new URL(`fixtures/test/${name}/`, root);
    const planText = await readFile(new URL("plan.md", dir), "utf8");
    const torText = name === "p2-plan-empty" ? TOR : await readFile(new URL("tor.md", dir), "utf8");
    const pelText = name === "p2-plan-empty" ? "" : await readFile(new URL("pel.md", dir), "utf8");
    const expected = JSON.parse(await readFile(new URL("expected.json", dir), "utf8"));
    assert.deepEqual(validateProjectPlan({ plan: planText, tor: torText, elicitationLog: pelText }).errors, expected, name);
  }
});

test("reports all failures at once", async () => {
  const empty = await readFile(new URL("fixtures/test/p2-plan-empty/plan.md", root), "utf8");
  const result = validateProjectPlan({ plan: empty, tor: TOR, elicitationLog: "" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 5);
  assert.equal(result.errors.filter((error) => error.startsWith("missing section:")).length, 7);
});

test("missing section fails", () => {
  const text = plan().replace("## 6. Risks", "## 6. Later");
  const result = validateProjectPlan({ plan: text, tor: TOR, elicitationLog: PEL });
  assert.ok(result.errors.includes("missing section: 6. Risks"));
});

test("§2 without IS ids fails", () => {
  assert.ok(errorsOf({ "2. Scope": "- **In scope:** the weekly note\n- **Out of scope:** OS-001" }).includes("§2 without IS ids"));
});

test("OS id as in-scope fails", () => {
  assert.ok(errorsOf({ "2. Scope": "- **In scope:** IS-001, OS-001\n- **Out of scope:** none" }).some((error) => error.includes("OS id as in-scope")));
});

test("cycle without IS fails", () => {
  const row = "| I-001 | 2026-11-16 | the note | Write | Which | Sample |";
  assert.ok(errorsOf({ "4. Planned work": row }).some((error) => error.startsWith("cycle without IS")));
});

test("uncovered IS fails", () => {
  const row = "| I-001 | 2026-11-16 | IS-001 | Write | Which | Sample |";
  assert.ok(errorsOf({ "4. Planned work": `| Cycle | Week | Scope | Aim | Question | Prototype |\n| --- | --- | --- | --- | --- | --- |\n${row}` }).includes("uncovered IS: IS-002"));
});

test("final figures without estimator name/date fail", () => {
  const found = errorsOf({
    "5. Economic evaluation": "| Cycle | Scope | Work | Suggested | Final |\n| --- | --- | --- | --- | --- |\n| I-001 | IS-001 | Draft | 2 days suggestion | 3 |",
  });
  assert.ok(found.includes("final figures without estimator name"));
  assert.ok(found.includes("final figures without estimator date"));
});

test("final figure without matching PEL answer fails", () => {
  assert.ok(errorsOf({}, "").includes("final figure without matching PEL answer"));
});

test("PEL answer from a non-approver is logged as input only and cannot satisfy a final figure", () => {
  const log = PEL.replace("U0CFRUV378D", "UOTHER123").replace("approved", "input");
  assert.ok(errorsOf({}, log).includes("PEL answer from a non-approver cannot satisfy a final figure"));
});

test("suggested duration not labelled fails", () => {
  const section = [
    "| Cycle | Scope | Work | Suggested | Final |",
    "| --- | --- | --- | --- | --- |",
    "| I-001 | IS-001 | Draft | 2 days | 3 |",
    "- Name: Anak",
    "- Date: 2026-11-14",
  ].join("\n");
  assert.ok(errorsOf({ "5. Economic evaluation": section }).includes("suggested duration not labelled"));
});

test("empty §6 without confirmed none fails", () => {
  assert.ok(errorsOf({ "6. Risks": "We will think about this later." }).includes("empty §6 without confirmed none"));
});

test("§7 missing TOR/SRS/Design fails", () => {
  const found = errorsOf({ "7. Documents we will produce": "| Document | Status |\n| --- | --- |\n| Notes | draft |" });
  assert.ok(found.includes("§7 missing TOR"));
  assert.ok(found.includes("§7 missing SRS"));
  assert.ok(found.includes("§7 missing Design"));
});

test("factory term in plan fails", () => {
  const found = errorsOf({
    "1. About this plan": "**Status:** draft\n\nSee the pull request.\n\n| Version | Date | Agreed by (team) | What changed |\n| --- | --- | --- | --- |\n| 1 | 2026-11-14 | delivery team | First plan |",
  });
  assert.ok(found.some((error) => error.includes("factory term") && error.includes("pull request")));
});

test("complete plan passes", () => {
  const result = validateProjectPlan({ plan: plan(), tor: TOR, elicitationLog: PEL });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('"to be agreed" day rate passes', () => {
  const section = [
    "| Cycle | Scope | Work | Suggested | Final |",
    "| --- | --- | --- | --- | --- |",
    "| I-001 | IS-001 | Draft | — | — |",
    "- Day rate and currency: to be agreed",
  ].join("\n");
  const result = validateProjectPlan({
    plan: plan({ "5. Economic evaluation": section }),
    tor: TOR,
    elicitationLog: "",
  });
  assert.equal(result.errors.some((error) => /day rate|estimator|PEL/i.test(error)), false);
  assert.equal(result.ok, true);
});
