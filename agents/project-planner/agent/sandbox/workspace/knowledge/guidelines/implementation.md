<!-- sources: tor-reference, srs-reference -->
<!-- priority: 100 -->

# Implementation

Implement one approved feature issue at a time.

## Rules

- Tests must pass before a pull request is opened.
- The test command is `node --test` with an optional path. Commands that deploy, push, or fetch from the network are refused.
- Do not edit the frozen TOR or earlier approved baselines.
- Do not implement excluded scope.
- Execute tests in the session sandbox. The sandbox network stays closed.
- A fixture is not a project baseline.
- The agent never merges and never deploys the application.
