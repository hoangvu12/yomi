# Cumulative streaming profile

Run `bun run profile:stream` to measure realistic small, medium, large, deeply
nested, and adversarial cumulative responses. The harness reports elapsed time
and observed heap growth as informational environment-dependent measurements,
plus stable parser work counters: input and cumulative parsed bytes, completion
scan characters, repair attempts, union candidate attempts, retained bytes, and
snapshot count.

Regression tests assert only stable work counters. They deliberately make no
wall-clock or heap assertions.

## Optimization threshold

Incremental checkpoints are justified only when all conditions hold:

1. at least two non-adversarial representative scenarios spend 500 ms or more
   in the parser on the reference development machine;
2. the behavior is reproduced across five runs; and
3. a checkpoint prototype reduces median elapsed time by at least 30% across
   five runs and cumulative bytes examined by at least 50%, without changing
   corpus/prefix replay results or resource-limit outcomes.

## Baseline evidence

Reference run on Windows/Node 22 (August 27, 2026):

| scenario | bytes / chunk | time (ms) | observed heap growth | cumulative parsed bytes | completion characters | repairs | candidates | snapshots | retained bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 16 / 2 | 6.81 | 492,744 | 88 | 72 | 7 | 0 | 4 | 16 |
| medium | 1,781 / 16 | 267.30 | 8,727,840 | 103,018 | 101,237 | 111 | 0 | 96 | 1,781 |
| large | 20,181 / 64 | 7,091.42 | 122,984,432 | 3,225,642 | 3,205,461 | 315 | 0 | 278 | 20,181 |
| deeply nested | 97 / 1 | 13.66 | 7,066,024 | 4,850 | 4,753 | 96 | 0 | 97 | 97 |
| adversarial | 8,034 / 8 | 199.50 | 10,138,104 | 4,052,148 | 4,044,114 | 2,002 | 0 | 1 | 8,034 |

Elapsed time and heap growth vary by run and are not test expectations. Only
the large scenario crossed the gate, so the evidence does not justify adding
lexical/AST checkpoint state yet. The counters clearly expose cumulative-work
growth and retain the evidence needed to revisit the decision as real workloads
evolve.
