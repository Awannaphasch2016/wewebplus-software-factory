<!-- sources: srs-reference -->
<!-- priority: 100 -->

# Requirement quality

Apply these gates to every requirement. Semantic judgment stays with the model and the human reviewer. Deterministic checks live in `validate_srs`.

1. Every requirement has support in the frozen TOR or in an approved elaboration.
2. Identifiers are stable and unique.
3. The statement is clear enough for a later design to use.
4. The statement is testable or otherwise verifiable.
5. Functional requirements and nonfunctional requirements stay distinct.
6. Acceptance criteria map to existing requirements.
7. An exclusion in the TOR is not silently reintroduced.
8. The specification does not silently contradict the frozen TOR.
9. Missing critical information is surfaced, not filled in.
10. Conflicts are surfaced, not smoothed over.
11. Unresolved assumptions stay visible.
12. Architecture is not chosen early unless the TOR or an approved decision requires it.
13. A revision keeps an identifier unless the requirement itself changes.
14. A model suggestion is a proposal until a person approves it.
15. Do not claim conformance to an external requirements or process standard.

Do not copy requirement text from a reference specification into a new project.
