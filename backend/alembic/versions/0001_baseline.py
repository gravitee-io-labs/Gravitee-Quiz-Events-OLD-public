"""baseline: the legacy (pre multi-event) schema

Revision ID: 0001
Revises:
Create Date: 2026-10-06

Makes "a brand new empty database" and "a production database created by the old application's
``Base.metadata.create_all`` (no alembic_version table, real data)" converge to the same revision.

* Every statement is idempotent (``IF NOT EXISTS``): on a legacy database NOTHING is touched, on an
  empty database the legacy tables are created exactly as the old SQLAlchemy models defined them
  (same column types, same auto-generated PostgreSQL constraint / index names, e.g. ``categories_pkey``,
  ``categories_name_key``, ``questions_category_id_fkey``). Revision 0002 then upgrades both the same way.
* The old models are NOT imported: this file is a frozen description of the legacy schema.
* Two columns that were added to the old models after the first release are also "ensured" so that a
  development database created by an older checkout does not break 0002 (``questions.category_id``,
  ``players.phone_number``). The production database already has them.
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


_TABLES = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL NOT NULL,
        username VARCHAR(100) NOT NULL,
        hashed_password VARCHAR(255) NOT NULL,
        is_active BOOLEAN,
        created_at TIMESTAMP WITHOUT TIME ZONE,
        CONSTRAINT users_pkey PRIMARY KEY (id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS categories (
        id SERIAL NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        color VARCHAR(7),
        is_active BOOLEAN,
        created_at TIMESTAMP WITHOUT TIME ZONE,
        updated_at TIMESTAMP WITHOUT TIME ZONE,
        CONSTRAINT categories_pkey PRIMARY KEY (id),
        CONSTRAINT categories_name_key UNIQUE (name)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS questions (
        id SERIAL NOT NULL,
        category_id INTEGER,
        question_text_en TEXT NOT NULL,
        question_text_fr TEXT NOT NULL,
        question_type VARCHAR(50),
        media_url VARCHAR(500),
        correct_answer VARCHAR(10) NOT NULL,
        green_label_en VARCHAR(100),
        green_label_fr VARCHAR(100),
        red_label_en VARCHAR(100),
        red_label_fr VARCHAR(100),
        explanation_en TEXT,
        explanation_fr TEXT,
        is_active BOOLEAN,
        difficulty INTEGER,
        created_at TIMESTAMP WITHOUT TIME ZONE,
        updated_at TIMESTAMP WITHOUT TIME ZONE,
        CONSTRAINT questions_pkey PRIMARY KEY (id),
        CONSTRAINT questions_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories (id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS players (
        id SERIAL NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone_number VARCHAR(20),
        created_at TIMESTAMP WITHOUT TIME ZONE,
        CONSTRAINT players_pkey PRIMARY KEY (id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS game_sessions (
        id SERIAL NOT NULL,
        player_id INTEGER NOT NULL,
        status VARCHAR(20),
        total_score INTEGER,
        correct_answers INTEGER,
        wrong_answers INTEGER,
        unanswered INTEGER,
        started_at TIMESTAMP WITHOUT TIME ZONE,
        completed_at TIMESTAMP WITHOUT TIME ZONE,
        game_config JSON,
        CONSTRAINT game_sessions_pkey PRIMARY KEY (id),
        CONSTRAINT game_sessions_player_id_fkey FOREIGN KEY (player_id) REFERENCES players (id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS game_answers (
        id SERIAL NOT NULL,
        game_session_id INTEGER NOT NULL,
        question_id INTEGER NOT NULL,
        player_answer VARCHAR(10),
        is_correct BOOLEAN,
        time_taken DOUBLE PRECISION,
        points_earned INTEGER,
        question_order INTEGER NOT NULL,
        answered_at TIMESTAMP WITHOUT TIME ZONE,
        CONSTRAINT game_answers_pkey PRIMARY KEY (id),
        CONSTRAINT game_answers_game_session_id_fkey FOREIGN KEY (game_session_id) REFERENCES game_sessions (id),
        CONSTRAINT game_answers_question_id_fkey FOREIGN KEY (question_id) REFERENCES questions (id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS game_settings (
        id SERIAL NOT NULL,
        questions_per_game INTEGER,
        timer_seconds INTEGER,
        points_correct INTEGER,
        points_wrong INTEGER,
        time_bonus_max INTEGER,
        category_distribution JSON,
        updated_at TIMESTAMP WITHOUT TIME ZONE,
        CONSTRAINT game_settings_pkey PRIMARY KEY (id)
    )
    """,
]

# Columns added to the old models after the first release (create_all never adds columns to a table
# that already exists, so a very old development database may lack them).
_LATE_COLUMNS = [
    "ALTER TABLE questions ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories (id)",
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20)",
]

_INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_categories_id ON categories (id)",
    "CREATE INDEX IF NOT EXISTS ix_users_id ON users (id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)",
    "CREATE INDEX IF NOT EXISTS ix_questions_id ON questions (id)",
    "CREATE INDEX IF NOT EXISTS ix_players_id ON players (id)",
    "CREATE INDEX IF NOT EXISTS ix_players_email ON players (email)",
    "CREATE INDEX IF NOT EXISTS ix_game_sessions_id ON game_sessions (id)",
    "CREATE INDEX IF NOT EXISTS ix_game_answers_id ON game_answers (id)",
    "CREATE INDEX IF NOT EXISTS ix_game_settings_id ON game_settings (id)",
]


def upgrade() -> None:
    for statement in (*_TABLES, *_LATE_COLUMNS, *_INDEXES):
        op.execute(statement)


def downgrade() -> None:
    # Intentionally empty: the baseline never drops tables (they may hold production data).
    pass
