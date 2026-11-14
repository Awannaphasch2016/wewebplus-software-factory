import assert from "node:assert/strict";
import test from "node:test";
import { citesUnknownIs, parseScopeIds, reintroducesOs } from "../lib/scope-ids.mjs";

const tor = [
  "## 3.1 In Scope",
  "- IS-001 Publish a weekly note",
  "## 3.2 Out of Scope",
  "- OS-001 External customer billing stays outside this work",
].join("\n");

test("parses IS/OS from TOR", () => {
  assert.deepEqual(parseScopeIds(tor), { inScope: ["IS-001"], outScope: ["OS-001"] });
  assert.deepEqual(citesUnknownIs("IS-001 and IS-009", ["IS-001"]), ["IS-009"]);
});

test("detects OS reintroduction", () => {
  assert.deepEqual(reintroducesOs(tor, "The note stays in scope."), []);
  assert.deepEqual(reintroducesOs(tor, "We will add OS-001 later."), ["OS-001"]);
  assert.deepEqual(
    reintroducesOs(tor, "External customer billing stays outside this work is now included."),
    ["OS-001"],
  );
});
