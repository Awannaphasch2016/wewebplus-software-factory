import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const guidelineUrl = new URL("knowledge/guidelines/project-plan.md", root);
const templateUrl = new URL(
  "knowledge/sources/project-plan-template/2026-11-13/project-plan-template.md",
  root,
);

function headings(markdown) {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

test("guideline has seven sections in template order", async () => {
  const guideline = await readFile(guidelineUrl, "utf8");
  const template = await readFile(templateUrl, "utf8");
  const expected = headings(template);
  assert.deepEqual(headings(guideline), expected);
  assert.equal(expected.length, 7);
});

test("guideline lists the five minimum statements", async () => {
  const guideline = await readFile(guidelineUrl, "utf8");
  for (const phrase of [
    "weekly Specification → Research → Prototype cycle",
    "at least one complete cycle per week",
    "evidence referenced from the Design Prototype",
    "requirements-gap route and a design-gap route",
    "the TOR is never changed",
  ]) {
    assert.equal(guideline.includes(phrase), true, phrase);
  }
});

test("guideline denylist is non-empty and project-agnostic", async () => {
  const guideline = await readFile(guidelineUrl, "utf8");
  for (const term of ["project.yaml", "pull request", "PR #", "Eve", "gate card", "PEL-", "merge commit SHAs"]) {
    assert.equal(guideline.includes(term), true, term);
  }
  assert.equal(/task-tracker|task tracker/i.test(guideline), false);
});
