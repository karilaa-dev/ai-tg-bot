# Legacy Pi fixtures

These modules preserve the v2 inference implementation for regression tests and historical smoke comparisons. The v3 application uses `src/codex/`; production code must not import this directory.

Legacy chat migration uses the read-only transcript parser in `src/codex/history.ts`, independently of these fixtures. Skills and settings in the old implementation still resolve against the repository working directory.
