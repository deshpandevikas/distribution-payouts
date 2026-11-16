---
inclusion: always
---
Learning project. Production systems already solve this; the point is the approach.
A distribution is split into investor payouts and sent to a fake bank that fails, times out,
goes silent, confirms twice, and confirms late. Guarantee: no investor paid twice, no payment lost,
totals exact, every payment ends in a clear final state. Correctness over speed.
Success metric: share of payments completing with no manual intervention
(manual = any payment that touches MANUAL_REVIEW).
