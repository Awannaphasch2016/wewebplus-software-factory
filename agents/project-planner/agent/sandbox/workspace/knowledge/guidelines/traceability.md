<!-- sources: srs-reference -->
<!-- priority: 100 -->

# Traceability

## Identifiers

Use these identifiers unless the project already has an approved scheme:

- Functional requirements: `FR-001`, `FR-002`, …
- Nonfunctional requirements: `NFR-001`, `NFR-002`, …
- Acceptance criteria: `AC-001`, `AC-002`, …
- Elicitation items: `EL-001`, `EL-002`, …

Three digits, unique within the document. Do not reuse a retired identifier for a different statement.

## Required links

Each functional or nonfunctional requirement has a `Source` line. The source is a TOR clause (for example `TOR 3.1`) or an elicitation item (`EL-001`).

Each acceptance criterion has a `Verifies` line naming one or more existing `FR-nnn` or `NFR-nnn` identifiers.

## Statement shape

```markdown
### FR-001

The product shall …

Source: TOR 3.1
```

```markdown
### AC-001

…

Verifies: FR-001
```

## Revisions

Keep the identifier when the wording is clarified and the obligation stays the same. Assign a new identifier when the obligation changes. Say which identifier was superseded.
