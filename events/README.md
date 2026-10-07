# Event bundles

Each file is an **event bundle** (`format: gravitee-quiz-event`, `version: 1`; schema in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §6): branding, rules, categories and questions of one event.

| File | Event | Content |
|---|---|---|
| `api-masters.json` | **API Masters** (slug `api-masters`) | 117 questions, 4 categories (REST API, Event API, AI, Gravitee). Seeded automatically on a **fresh** database. |
| `world-ai-summit-2026.json` | **AI Masters** at World Summit AI – Amsterdam 2026 (slug `world-ai-summit-2026`) | 124 bilingual (EN/FR) questions, 5 categories. Imported explicitly (not auto-seeded). |

```bash
python3 scripts/validate_bundle.py events/world-ai-summit-2026.json --strict   # lint a bundle
python3 scripts/quizctl.py import events/world-ai-summit-2026.json             # create the event
python3 scripts/quizctl.py import events/world-ai-summit-2026.json --slug ai-masters-test --status draft
```

You can also import from **Admin console → All events → New event → Import bundle**.

## AI Masters question set

Five categories with equal weight (3 per 15-question game, played easy → hard):

| Category | FR | Questions |
|---|---|---|
| LLMs & GenAI | LLM & IA générative | 25 |
| MCP & Protocols | MCP & protocoles | 24 |
| AI Agents | Agents IA | 24 |
| AI Security & Governance | Sécurité & gouvernance de l’IA | 24 |
| Gravitee for AI | Gravitee pour l’IA | 27 |

Difficulty (1 easy · 2 medium · 3 hard) is about 40 / 40 / 20, true/false vs two-choice about 55 / 45, and green/red answers
are balanced. Every question has an English and a French text, labels and a teaching explanation. The set was fact-checked,
played "cold" by an independent reviewer for ambiguity and difficulty, and edited for French quality; the Gravitee-specific
questions only rely on publicly documented, generally available behaviour.

## Adding or changing questions

Use the admin console (Questions tab: editor with live player preview, CSV import with dry-run, bulk actions), or edit a
bundle and re-import it as a new event. Keep `true_false` labels `TRUE/FALSE` (`Vrai/Faux`), two-choice labels ≤ 28 characters
(they sit on big buttons), and run `scripts/validate_bundle.py --strict`. To flag vocabulary that must never appear in a public
question (customers, competitors, unreleased features), list one regular expression per line in
`scripts/leak-terms.local.txt` (gitignored) and the validator will check for it.
