---
inclusion: always
---
- Money is integer cents (number, safe-integer checked). Never floats. No currency other than USD.
- Do not guess library APIs. Read current docs and cite the URL in your reply; if unsure, say so.
- Never edit src/core/stateMachine.ts transition table or test/invariants.test.ts without being asked;
  propose changes in chat instead. The human owns those.
- All data is fake. No real bank names, no credentials, no company names, no mention of jobs or interviews.
- Every source of time or randomness is injected (Clock, Rng). No Date.now() or Math.random() in src/.
- Ask before adding any dependency beyond: typescript, vitest, fast-check, tsx.
- Keep functions small and named for intent. No clever abstractions without a second use.
