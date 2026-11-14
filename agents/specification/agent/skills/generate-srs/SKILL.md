---
description: Draft or revise the SRS with stable ids, traceability, and acceptance criteria, then run validate_srs before any pull request.
---

# Generate the SRS

Write `docs/srs.md` with these sections, in order:

1. Introduction
2. Scope
3. Functional Requirements
4. Nonfunctional Requirements
5. Acceptance Criteria
6. Constraints and References

Use `FR-001`, `NFR-001`, and `AC-001` headings. Give every functional and nonfunctional requirement a `Source` that cites at least one `IS-nnn` present in the approved TOR. An `EL-nnn` item may be cited in addition. Do not cite an `OS-nnn`, and do not restate text the TOR excludes. Give every acceptance criterion a `Verifies` line pointing at existing requirement ids.

Preserve identifiers when you revise wording and the obligation stays the same. Do not reintroduce TOR exclusions. Do not invent numerical thresholds. Do not choose architecture unless the TOR or an approved decision requires it. Leave unresolved assumptions visible.

Call `validate_srs` before `create_srs_pull_request`. If validation fails, or a gap line is still `blocking | unresolved`, fix the document or ask another question. Do not open the pull request.

The pull request cites `tor.baseline.mergeCommit` and `tor.baseline.sha256`. It must not change `docs/tor.md` and it must not commit `docs/_analysis.md`. Refuse the pull request when the TOR is not approved, the TOR hash does not match, the project plan is not approved, the plan hash is paused, or `srs.status` is `needs-review`.
