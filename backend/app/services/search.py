"""Helpers for the admin ``search`` boxes (case-insensitive substring match, wildcards taken literally)."""
from typing import Optional

LIKE_ESCAPE = "\\"  # pass as ``escape=LIKE_ESCAPE`` next to the pattern


def search_term(raw: Optional[str]) -> str:
    """The user's text without NUL (illegal in PostgreSQL text) and surrounding blanks; ``""`` = no filter."""
    return (raw or "").replace("\x00", "").strip()


def like_pattern(term: str) -> str:
    """``%term%`` with the LIKE wildcards of ``term`` escaped (use with ``escape=LIKE_ESCAPE``)."""
    escaped = term.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2).replace("%", LIKE_ESCAPE + "%").replace("_", LIKE_ESCAPE + "_")
    return f"%{escaped}%"
