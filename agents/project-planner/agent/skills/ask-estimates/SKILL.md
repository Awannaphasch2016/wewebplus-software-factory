---
description: Ask an approver for final person-day figures and record the answer as a PEL entry.
---

# Ask for estimates

Call `ask_question` for every final figure. Store the answer as `PEL-nnn` with `field`, `value`, `responder`, `timestamp`, and `resolution: approved` only when the responder is on `FACTORY_GATE_APPROVER_IDS`. Otherwise use `resolution: input`.
