<!-- sources: project-plan-template -->
<!-- priority: 100 -->

# Project plan

Use this guideline to draft a project plan from the approved template. Keep the seven sections below, in this order. Extra text is allowed. A section may be strengthened. It may not be dropped, reordered, or relaxed.

## 1. About this plan

`Status:` is `draft` or `agreed`. A version-history table is required. Cells under "Agreed by" use team names only. They contain no Slack ids and the word "bot" is not a name.

### Terms that do not belong in a client plan

Report each of these as an error with its line number:

- agent names
- `project.yaml`
- pull request
- `PR #`
- branch prefixes
- Eve
- gate card
- `EL-`
- `TEL-`
- `PEL-`
- merge commit SHAs

## 2. Scope

Cite only `IS-nnn` identifiers that exist in the approved TOR. List that TOR's `OS-nnn` identifiers only as out of scope. An `OS-nnn` identifier does not appear in a scope column of section 4 or section 5.

## 3. How we will work together

These five minimum statements are required. Extra text passes. The statements may be strengthened, not relaxed:

1. weekly Specification → Research → Prototype cycle
2. at least one complete cycle per week
3. evidence referenced from the Design Prototype
4. the end-of-cycle two questions, with a requirements-gap route and a design-gap route
5. the TOR is never changed; a change to the TOR means a new project

## 4. Planned work

At least one `I-nnn` row. Every row cites at least one known `IS-nnn`. Every `IS-nnn` in the approved TOR is covered by some cycle. An `I-nnn` identifier is the letter I, a hyphen, and three digits, and it is unique in the plan.

## 5. Economic evaluation

Final person-day figures and the economic assumptions come from a named human whose Slack id is on `FACTORY_GATE_APPROVER_IDS`. An answer from anyone else may be stored as input only and cannot satisfy a final figure. A suggested duration appears only in the suggestion column and contains the word "suggestion". "to be agreed" is allowed for the day rate and for money totals. When any final figure is present, the estimator name and date are present. The estimator name matches that responder's Slack display name.

PEL field keys:

- `s5.work.<I-nnn>.final`
- `s5.assumptions.dayRate`
- `s5.estimator.name`

## 6. Risks

Use `R-nnn` rows, or a confirmed "none identified" with a PEL entry. An `R-nnn` identifier is the letter R, a hyphen, and three digits, and it is unique in the plan.

## 7. Documents we will produce

List the TOR (WP-PS-SOW-01, A2-01), this plan, the SRS, and Design/Prototype. Each row has a status.
