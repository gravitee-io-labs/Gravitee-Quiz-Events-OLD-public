# Legacy database fixture

Production ran the pre multi-event application, whose schema was created by `Base.metadata.create_all`
(no Alembic). `builder.py` reproduces that database so the migrations (`backend/alembic/versions`) can be
tested against the real thing.

* `legacy_app/app/{models,database,config}.py` are **verbatim copies** of the old backend at git commit
  `63d4171955b2c6b2a0e5349f7da9e656334cf874` (4 comment lines added at the top). They are never imported by the test
  process: `builder.init_legacy_schema` runs the old `init_db()` in a subprocess against the target database.
  `test_vendored_legacy_code_matches_git_history` and `test_git_extracted_legacy_code_builds_the_same_schema`
  prove the copy equals the git history (`source="git"` runs the code extracted with `git archive` instead).
* `builder.populate_dataset` adds the deterministic dataset (seed `20261006`): 3 categories, 120 questions
  (60 TRUE/FALSE, 35 named choices, 5 inverted, 80 categorised), 200 players, 206 game sessions (200 completed,
  5 in progress, 1 abandoned), 2772 answers and a customised `game_settings` row.
* `builder.snapshot` = per-table row counts + md5 of every legacy column, used to prove nothing was lost.

Manual use (the database must exist and be empty):

    docker run -d --name quiz-test-pg -e POSTGRES_USER=quiz_user -e POSTGRES_PASSWORD=quiz_password \
        -e POSTGRES_DB=gravitee_quiz -p 127.0.0.1:55432:5432 postgres:15-alpine
    cd backend && .venv/bin/python -m tests.legacy.builder postgresql://quiz_user:quiz_password@127.0.0.1:55432/gravitee_quiz

Real production dump (never committed; `backups/` is git-ignored):
`TEST_PROD_DUMP=/path/to/dump TEST_POSTGRES_URL=... pytest tests/test_migrations.py -k real_production -s`.
