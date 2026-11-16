---
inclusion: always
---
TypeScript strict mode, Node current LTS pinned in .nvmrc, ESM.
Tests: Vitest + fast-check. Phase 1 has no database and no Temporal.
Core is pure: storage and bank are interfaces passed in (ports and adapters),
so the same core later runs in the browser, under Temporal, and over SQLite.
