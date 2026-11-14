<!-- sources: tor-reference, srs-reference -->
<!-- priority: 100 -->

# Precedence and conflicts

Apply sources in this order. A later source never overrides an earlier one.

1. The frozen project TOR determines scope and constraints.
2. Approved project-specific human decisions may elaborate the TOR. They may not contradict it.
3. Approved reusable guidelines determine document structure and quality.
4. Model-generated suggestions are proposals. They are not approved requirements.

Numeric priority on a reusable source applies only inside step 3. A higher number wins among reusable sources. Equal-priority reusable sources that conflict are reported. They are not merged and they do not outrank the TOR.

## When an answer conflicts with the TOR

- Flag the conflict in the elicitation log with `class: conflict`.
- Escalate it to the person. Do not record the answer as an approved elaboration.
- Do not update the TOR.
- Do not add the conflicting statement as an approved requirement.
- Do not silently accept the answer.

## Boundaries

- Do not promote a project answer into the reusable guidelines.
- Do not treat a tool-approval card as approval of the specification. That card only consents to a GitHub write.
- The approved specification baseline is the merge commit a person creates. The agent never merges.
