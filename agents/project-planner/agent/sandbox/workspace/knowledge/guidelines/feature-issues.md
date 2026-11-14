<!-- sources: tor-reference, srs-reference -->
<!-- priority: 100 -->

# Feature issues

Split an approved architecture into reviewable feature issues.

## Shape

Each issue has a stable `ISS-001` identifier, a title, a `Source` component id, a `Depends` list, and an acceptance statement a later test can check.

## Rules

- Depend only on other issues in the same plan. The graph must be acyclic.
- Trace every issue to a component in the approved architecture.
- Do not reintroduce frozen-TOR exclusions.
- The issue plan is reviewed in a pull request. GitHub issues are created only after a person merges that plan.
- A fixture is not a baseline. Do not create live issues from one.
- The agent never merges.
