<!-- sources: tor-reference, srs-reference -->
<!-- priority: 100 -->

# Architecture design

An architecture design elaborates an approved SRS. It does not replace the frozen TOR or the approved SRS.

## Required sections

1. Introduction
2. Constraints
3. Components, each with a stable `C-001` identifier and a `Source` citing an `FR-nnn` or `NFR-nnn` from the approved SRS
4. Interfaces
5. Data
6. Decisions and deferrals
7. Traceability

Cite the SRS baseline hash in the form `SRS baseline: <64 hex characters>`.

## Rules

- Precedence stays: frozen TOR, then approved human decisions, then these guidelines, then model suggestions.
- Do not reintroduce an exclusion from the TOR or SRS. In particular, do not add external customer access as a component obligation.
- Do not prescribe a vendor, framework, or host unless the approved SRS or an approved decision requires it.
- A fixture under `fixtures/test/` is test input. It is not a project baseline and cannot be approved onto a project.
- The agent opens a pull request for a real project and never merges it. A person merges. The baseline commit is recorded only after that merge.
