"""
Pydantic v2 schemas (requests / responses / event bundle) for Gravitee Quiz Events.
Contract: docs/ARCHITECTURE.md sections 5 and 6.

Conventions
-----------
* Input text is stripped; for *nullable* text fields an empty string becomes ``None``.
* Datetimes leave the API as ISO-8601 UTC with a trailing ``Z`` (``UTCDateTime``).
* Admin/public schemas ignore unknown keys (so an SPA may send back a whole object);
  the bundle schemas (``BundleV1`` and nested) are STRICT (``extra="forbid"``).
* ``*Update`` schemas are PARTIAL: use ``model_dump(exclude_unset=True)``; an explicit ``null`` is
  only legal for nullable fields (anything else is a 422). ``branding`` merges key by key.
* Public game schemas never contain the correct answer or explanation before submit.

Reusable pieces for other modules: ``RESERVED_SLUGS``, ``validate_slug``, ``normalize_question_fields``,
``QuestionUpdate.resolve``, ``infer_question_format``, ``EventSettings``, ``Branding``, ``BundleV1``.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Annotated, Any, ClassVar, Literal, Optional

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    model_validator,
)

from app.models import DEFAULT_ACCENT_COLOR, DEFAULT_PRIMARY_COLOR

# ---------------------------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------------------------
RESERVED_SLUGS: frozenset[str] = frozenset(
    "api admin assets shared css js vendor fonts static health docs openapi favicon robots "
    "scoreboard game events new login config index manifest sw".split()
)
SLUG_PATTERN = r"^[a-z0-9]+(-[a-z0-9]+)*$"
SLUG_MIN_LENGTH = 2
SLUG_MAX_LENGTH = 48
HEX_COLOR_PATTERN = r"^#[0-9A-Fa-f]{6}$"
BUNDLE_FORMAT = "gravitee-quiz-event"
BUNDLE_VERSION = 1
MAX_BUNDLE_CATEGORIES = 100
MAX_BUNDLE_QUESTIONS = 5000

Language = Literal["en", "fr"]
EventStatus = Literal["draft", "live", "closed"]
QuestionOrder = Literal["random", "easy_to_hard"]
CollectPhone = Literal["hidden", "optional", "required"]
QuestionFormat = Literal["true_false", "two_choices"]
AnswerValue = Literal["green", "red"]
BackgroundStyle = Literal["aurora", "grid", "plain"]
Theme = Literal["dark", "light", "system"]
BulkAction = Literal["activate", "deactivate", "delete", "set_category", "set_difficulty"]
GameStatus = Literal["in_progress", "completed", "abandoned"]
ResultOrder = Literal["recent", "score"]

TRUE_FALSE_LABELS: dict[str, str] = {
    "green_label_en": "TRUE",
    "green_label_fr": "Vrai",
    "red_label_en": "FALSE",
    "red_label_fr": "Faux",
}
LABEL_FIELDS: tuple[str, ...] = tuple(TRUE_FALSE_LABELS)
MAX_LABEL_LENGTH = 100  # DB column size

_SLUG_RE = re.compile(SLUG_PATTERN)


# ---------------------------------------------------------------------------------------------
# Reusable annotated types / validators
# ---------------------------------------------------------------------------------------------
def _blank_to_none(v: Any) -> Any:
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def validate_slug(value: str) -> str:
    """Slug rules: regex, 2-48 chars, not reserved. Raises ``ValueError``."""
    if not isinstance(value, str):
        raise ValueError("slug must be a string")
    if not SLUG_MIN_LENGTH <= len(value) <= SLUG_MAX_LENGTH:
        raise ValueError(f"slug must be {SLUG_MIN_LENGTH}-{SLUG_MAX_LENGTH} characters long")
    if not _SLUG_RE.match(value):
        raise ValueError(
            "slug may only contain lowercase letters, digits and single hyphens "
            "(no leading, trailing or doubled hyphen)"
        )
    if value in RESERVED_SLUGS:
        raise ValueError(f"'{value}' is a reserved slug")
    return value


# ``https://`` + host (letters, digits, dots, hyphens: no userinfo, never empty) + optional port + optional path / query / fragment
_HTTPS_ASSET_URL_RE = re.compile(r"https://[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?(/[^\s]*)?")
# Anything that has no business in an image URL, whatever the shape: whitespace and control characters (also the C1
# range and the Unicode line separators), invisible bidi / zero-width characters (an URL that reads differently from
# what it is), percent-encoded control characters (%0d%0a header splitting, %00), and the quote / angle / backslash
# characters that break out of an attribute or turn "/\\evil.example" into a protocol-relative URL.
_ASSET_URL_UNSAFE_RE = re.compile(
    r"[\s<>\"'`\\\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]"
    r"|%(?:[01][0-9a-fA-F]|7[fF])"
)
_ASSET_URL_MAX_LENGTH = 500


def _validate_asset_url(value: Optional[str]) -> Optional[str]:
    """An absolute ``https://host[:port]/path`` URL, or a site-relative path starting with ONE ``/``
    (``/assets/x.png``); the UI CSP allows nothing else. Raises ``ValueError``.

    * https: no userinfo (``https://trusted@evil.example``), no empty host, no port above 65535;
    * path: not protocol-relative (``//host``), no ``..`` (nor its encoded form ``%2e``), no backslash;
    * both: no whitespace, control, bidi or zero-width characters, no encoded CR / LF / NUL (see ``_ASSET_URL_UNSAFE_RE``).
    """
    if value is None:
        return None
    if len(value) > _ASSET_URL_MAX_LENGTH:
        raise ValueError(f"url must be at most {_ASSET_URL_MAX_LENGTH} characters")
    if _ASSET_URL_UNSAFE_RE.search(value):
        raise ValueError("url must not contain spaces, control or invisible characters, or quote/angle/backslash characters")
    if value.startswith("https://"):
        match = _HTTPS_ASSET_URL_RE.fullmatch(value)
        if match is None:
            raise ValueError("url must be https://host[:port]/path (no credentials, no empty host)")
        if match.group(1) and int(match.group(1)[1:]) > 65535:
            raise ValueError("url has an invalid port")
        return value
    if value.startswith("/") and not value.startswith("//"):
        if ".." in value or re.search(r"%2e", value, re.IGNORECASE):
            raise ValueError("url path must not contain '..'")
        return value
    raise ValueError("url must start with https:// or be a site-relative path starting with a single /")


def _as_utc(value: datetime) -> datetime:
    """Naive datetimes coming from the DB are UTC; make them explicit so they serialise with 'Z'."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _validate_languages(value: list[str]) -> list[str]:
    if not value:
        raise ValueError("languages must contain at least one language")
    if len(set(value)) != len(value):
        raise ValueError("languages must not contain duplicates")
    return value


def _hex_upper(value: str) -> str:
    return value.upper()


Slug = Annotated[str, AfterValidator(validate_slug)]
HexColor = Annotated[str, StringConstraints(pattern=HEX_COLOR_PATTERN), AfterValidator(_hex_upper)]
AssetUrl = Annotated[Optional[str], BeforeValidator(_blank_to_none), AfterValidator(_validate_asset_url)]
UTCDateTime = Annotated[datetime, AfterValidator(_as_utc)]
Languages = Annotated[list[Language], AfterValidator(_validate_languages)]

EventName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
GameTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
CategoryName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


def _opt_text(max_length: int):
    """Nullable text: stripped, blank -> None, bounded."""
    return Annotated[
        Optional[Annotated[str, StringConstraints(max_length=max_length)]],
        BeforeValidator(_blank_to_none),
        Field(default=None),
    ]


OptText100 = _opt_text(100)
OptText200 = _opt_text(200)
OptText300 = _opt_text(300)
OptText2000 = _opt_text(2000)
OptText4000 = _opt_text(4000)
OptLabel = _opt_text(MAX_LABEL_LENGTH)


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class PatchModel(BaseModel):
    """Base for partial-update schemas: explicit ``null`` is rejected on non-nullable fields."""

    non_nullable: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="after")
    def _reject_explicit_null(self):
        bad = sorted(f for f in self.model_fields_set if f in self.non_nullable and getattr(self, f) is None)
        if bad:
            raise ValueError(f"{', '.join(bad)} cannot be null")
        return self


# ---------------------------------------------------------------------------------------------
# Generic / health / auth
# ---------------------------------------------------------------------------------------------
class HealthStatus(BaseModel):
    status: str = "ok"
    db: str = "ok"


class LiveStatus(BaseModel):
    """Liveness answer: the process is up (says nothing about the database, see ``HealthStatus``)."""

    status: str = "ok"


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=200)
    password: str = Field(..., min_length=1, max_length=500)


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: Optional[int] = Field(None, description="Token lifetime in seconds")


class TokenData(BaseModel):
    username: Optional[str] = None


class AdminMe(BaseModel):
    username: str


class MessageResponse(BaseModel):
    message: str


# ---------------------------------------------------------------------------------------------
# Branding & settings
# ---------------------------------------------------------------------------------------------
class Branding(BaseModel):
    primary_color: HexColor = DEFAULT_PRIMARY_COLOR
    accent_color: HexColor = DEFAULT_ACCENT_COLOR
    background_style: BackgroundStyle = "aurora"
    logo_url: AssetUrl = None
    default_theme: Theme = "dark"
    # "Scan to play" QR code on the scoreboard. Turn it off for an event that is played at the booth only.
    show_join_qr: bool = True


class BrandingUpdate(PatchModel):
    """Partial branding: only the keys present are changed (merged key by key)."""

    non_nullable: ClassVar[frozenset[str]] = frozenset(
        {"primary_color", "accent_color", "background_style", "default_theme", "show_join_qr"}
    )

    primary_color: Optional[HexColor] = None
    accent_color: Optional[HexColor] = None
    background_style: Optional[BackgroundStyle] = None
    logo_url: AssetUrl = None  # explicit null clears the logo
    default_theme: Optional[Theme] = None
    show_join_qr: Optional[bool] = None


class BundleBranding(Branding):
    model_config = ConfigDict(extra="forbid")


CategoryWeight = Annotated[int, Field(ge=0, le=1000)]


def _check_distribution(value: Optional[dict[str, int]]) -> Optional[dict[str, int]]:
    if not value:
        return None
    if sum(value.values()) <= 0:
        raise ValueError("category_distribution needs at least one weight > 0")
    return value


def _check_id_keys(value: Optional[dict[str, int]]) -> Optional[dict[str, int]]:
    if value:
        for key in value:
            if not key.isdigit():
                raise ValueError(f"category_distribution keys must be category ids, got '{key}'")
    return value


# {"<category_id>": weight} (admin / DB representation)
CategoryDistribution = Annotated[
    Optional[dict[str, CategoryWeight]],
    AfterValidator(_check_id_keys),
    AfterValidator(_check_distribution),
]
# {"<category name>": weight} (bundle representation)
NamedCategoryDistribution = Annotated[
    Optional[dict[Annotated[str, StringConstraints(min_length=1, max_length=100)], CategoryWeight]],
    AfterValidator(_check_distribution),
]


class EventSettingsPublic(BaseModel):
    """Rules visible to players (EventPublic.settings)."""

    questions_per_game: int = Field(15, ge=1, le=50)
    timer_seconds: int = Field(20, ge=5, le=120)
    points_correct: int = Field(100, ge=0, le=100_000)
    points_wrong: int = Field(0, ge=0, le=100_000)
    time_bonus_max: int = Field(50, ge=0, le=100_000)
    question_order: QuestionOrder = "random"
    collect_phone: CollectPhone = "optional"
    consent_text_en: OptText2000 = None
    consent_text_fr: OptText2000 = None


class EventSettings(EventSettingsPublic):
    """Full rules (admin): public rules + category weights keyed by category id."""

    category_distribution: CategoryDistribution = None


class EventSettingsUpdate(PatchModel):
    non_nullable: ClassVar[frozenset[str]] = frozenset(
        {
            "questions_per_game",
            "timer_seconds",
            "points_correct",
            "points_wrong",
            "time_bonus_max",
            "question_order",
            "collect_phone",
        }
    )

    questions_per_game: Optional[int] = Field(None, ge=1, le=50)
    timer_seconds: Optional[int] = Field(None, ge=5, le=120)
    points_correct: Optional[int] = Field(None, ge=0, le=100_000)
    points_wrong: Optional[int] = Field(None, ge=0, le=100_000)
    time_bonus_max: Optional[int] = Field(None, ge=0, le=100_000)
    question_order: Optional[QuestionOrder] = None
    collect_phone: Optional[CollectPhone] = None
    consent_text_en: OptText2000 = None  # explicit null / "" removes the consent checkbox
    consent_text_fr: OptText2000 = None
    category_distribution: CategoryDistribution = None  # explicit null => equal split


class BundleSettings(EventSettingsPublic):
    """Rules inside a bundle: category weights keyed by category NAME."""

    model_config = ConfigDict(extra="forbid")

    category_distribution: NamedCategoryDistribution = None


# ---------------------------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------------------------
class CategoryRef(ORMModel):
    """Category as embedded in questions / review items."""

    id: int
    name: str
    name_fr: Optional[str] = None
    color: str


class CategoryPublic(CategoryRef):
    """Category as listed in EventPublic (active, with >= 1 active question)."""

    question_count: int = 0


class CategoryCreate(BaseModel):
    name: CategoryName
    name_fr: OptText100 = None
    description: OptText2000 = None
    description_fr: OptText2000 = None
    color: HexColor = DEFAULT_PRIMARY_COLOR
    is_active: bool = True


class CategoryUpdate(PatchModel):
    non_nullable: ClassVar[frozenset[str]] = frozenset({"name", "color", "is_active"})

    name: Optional[CategoryName] = None
    name_fr: OptText100 = None
    description: OptText2000 = None
    description_fr: OptText2000 = None
    color: Optional[HexColor] = None
    is_active: Optional[bool] = None


class CategoryAdmin(ORMModel):
    id: int
    event_id: int
    name: str
    name_fr: Optional[str] = None
    description: Optional[str] = None
    description_fr: Optional[str] = None
    color: str
    is_active: bool = True
    question_count: int = 0


# ---------------------------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------------------------
QUESTION_FIELDS: tuple[str, ...] = (
    "category_id",
    "question_format",
    "question_text_en",
    "question_text_fr",
    "question_type",
    "media_url",
    "correct_answer",
    *LABEL_FIELDS,
    "explanation_en",
    "explanation_fr",
    "is_active",
    "difficulty",
)


def infer_question_format(green_label_en: Optional[str], red_label_en: Optional[str]) -> str:
    """``true_false`` when the English labels are TRUE / FALSE (any case), else ``two_choices``.

    Same rule as the 0002 migration backfill; used by the CSV import when the column is absent.
    """
    if (green_label_en or "").strip().upper() == "TRUE" and (red_label_en or "").strip().upper() == "FALSE":
        return "true_false"
    return "two_choices"


def normalize_question_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Apply the question_format rules to a COMPLETE question dict (returns it, mutated).

    * ``true_false``  -> labels forced to TRUE / FALSE / Vrai / Faux.
    * ``two_choices`` -> ``green_label_en`` and ``red_label_en`` required and different; a missing
      French label falls back to the English one; every label <= 100 chars.
    Raises ``ValueError`` (usable inside validators; admin code maps it to a 422/400).
    """
    fmt = data.get("question_format") or "true_false"
    if fmt not in ("true_false", "two_choices"):
        raise ValueError("question_format must be 'true_false' or 'two_choices'")
    data["question_format"] = fmt
    if fmt == "true_false":
        data.update(TRUE_FALSE_LABELS)
        return data
    labels = {k: (data.get(k) or "").strip() for k in LABEL_FIELDS}
    if not labels["green_label_en"] or not labels["red_label_en"]:
        raise ValueError("two_choices questions require green_label_en and red_label_en")
    if labels["green_label_en"].casefold() == labels["red_label_en"].casefold():
        raise ValueError("the two answer labels must be different")
    labels["green_label_fr"] = labels["green_label_fr"] or labels["green_label_en"]
    labels["red_label_fr"] = labels["red_label_fr"] or labels["red_label_en"]
    for key, value in labels.items():
        if len(value) > MAX_LABEL_LENGTH:
            raise ValueError(f"{key} must be at most {MAX_LABEL_LENGTH} characters")
    data.update(labels)
    return data


class QuestionContent(BaseModel):
    """Fields shared by QuestionCreate and the bundle question."""

    question_format: QuestionFormat = "true_false"
    difficulty: int = Field(1, ge=1, le=5)  # 1 easy, 2 medium, 3 hard (4-5 allowed)
    question_text_en: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    question_text_fr: OptText2000 = None  # falls back to EN when absent
    question_type: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z_]{0,49}$")] = "text"
    media_url: AssetUrl = None
    correct_answer: AnswerValue
    green_label_en: OptLabel = None
    green_label_fr: OptLabel = None
    red_label_en: OptLabel = None
    red_label_fr: OptLabel = None
    explanation_en: OptText4000 = None
    explanation_fr: OptText4000 = None
    is_active: bool = True

    @model_validator(mode="after")
    def _apply_format_rules(self):
        data = normalize_question_fields({k: getattr(self, k) for k in ("question_format", *LABEL_FIELDS)})
        for key in LABEL_FIELDS:
            setattr(self, key, data[key])
        return self


class QuestionCreate(QuestionContent):
    category_id: Optional[int] = None


class QuestionUpdate(PatchModel):
    """Partial question update. Combine with the stored values through ``resolve``."""

    # The French labels are nullable on purpose: null (or blank) = "no French label, show the English one",
    # exactly like at creation (the admin console sends null for a blank French label).
    non_nullable: ClassVar[frozenset[str]] = frozenset(
        {
            "question_format", "question_text_en", "question_type", "correct_answer", "is_active", "difficulty",
            "green_label_en", "red_label_en",
        }
    )  # fmt: skip

    category_id: Optional[int] = None  # explicit null => uncategorised
    question_format: Optional[QuestionFormat] = None
    difficulty: Optional[int] = Field(None, ge=1, le=5)
    question_text_en: Optional[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    ] = None
    question_text_fr: OptText2000 = None
    question_type: Optional[Annotated[str, StringConstraints(pattern=r"^[a-z][a-z_]{0,49}$")]] = None
    media_url: AssetUrl = None
    correct_answer: Optional[AnswerValue] = None
    green_label_en: OptLabel = None
    green_label_fr: OptLabel = None
    red_label_en: OptLabel = None
    red_label_fr: OptLabel = None
    explanation_en: OptText4000 = None
    explanation_fr: OptText4000 = None
    is_active: Optional[bool] = None

    def resolve(self, current: dict[str, Any]) -> dict[str, Any]:
        """Return the column values to set on the stored question (only those that change).

        ``current`` maps every name in ``QUESTION_FIELDS`` to the stored value
        (``{f: getattr(q, f) for f in QUESTION_FIELDS}``). Applies the format/label rules to the
        merged state (e.g. switching to ``true_false`` rewrites the labels). Raises ``ValueError``.

        Switching INTO ``two_choices``: a French label is the translation of the English label stored next
        to it. When the request brings a new English label but no French one, the stored French label
        (``Vrai`` / ``Faux`` of the old true/false pair) is stale, so it is dropped and falls back to the
        new English label instead of surviving next to it. French labels that are sent are kept, and
        labels the request does not mention at all keep their stored pair.
        """
        changes = self.model_dump(exclude_unset=True)
        merged = {**current, **changes}
        if merged.get("question_format") == "two_choices" and current.get("question_format") != "two_choices":
            for english, french in (("green_label_en", "green_label_fr"), ("red_label_en", "red_label_fr")):
                if english in changes and french not in changes:
                    merged[french] = None
        normalize_question_fields(merged)
        return {k: v for k, v in merged.items() if k in QUESTION_FIELDS and v != current.get(k)}


class QuestionAdmin(ORMModel):
    id: int
    event_id: int
    category_id: Optional[int] = None
    category: Optional[CategoryRef] = None
    question_format: QuestionFormat
    question_text_en: str
    question_text_fr: Optional[str] = None
    question_type: str = "text"
    media_url: Optional[str] = None
    correct_answer: AnswerValue
    green_label_en: str
    green_label_fr: str
    red_label_en: str
    red_label_fr: str
    explanation_en: Optional[str] = None
    explanation_fr: Optional[str] = None
    is_active: bool = True
    difficulty: int
    created_at: UTCDateTime
    updated_at: UTCDateTime


class QuestionPage(BaseModel):
    items: list[QuestionAdmin]
    total: int


class QuestionBulkRequest(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=5000)
    action: BulkAction
    category_id: Optional[int] = None  # for set_category; null => uncategorised
    difficulty: Optional[int] = Field(None, ge=1, le=5)  # for set_difficulty

    @model_validator(mode="after")
    def _check_action_arguments(self):
        if self.action == "set_category" and "category_id" not in self.model_fields_set:
            raise ValueError("category_id is required for set_category (null to un-categorise)")
        if self.action == "set_difficulty" and self.difficulty is None:
            raise ValueError("difficulty is required for set_difficulty")
        return self


class BulkResult(BaseModel):
    affected: int


class CsvImportError(BaseModel):
    row: int
    message: str


class CsvImportResult(BaseModel):
    created: int = 0
    skipped_duplicates: int = 0
    categories_created: int = 0
    errors: list[CsvImportError] = []
    dry_run: bool = False


# ---------------------------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------------------------
def _check_event_combo(
    languages: Optional[list[str]],
    default_language: Optional[str],
    starts_on: Optional[date],
    ends_on: Optional[date],
) -> None:
    if languages is not None and default_language is not None and default_language not in languages:
        raise ValueError("default_language must be one of languages")
    if starts_on and ends_on and ends_on < starts_on:
        raise ValueError("ends_on must not be before starts_on")


def validate_language_combo(languages: list[str], default_language: str) -> None:
    """Cross-field rule for already-merged values (services / admin updates). Raises ``ValueError``."""
    _check_event_combo(languages, default_language, None, None)


class EventSummary(ORMModel):
    """Public listing card (hub)."""

    slug: str
    name: str
    game_title: str
    status: EventStatus
    tagline_en: Optional[str] = None
    tagline_fr: Optional[str] = None
    description_en: Optional[str] = None
    description_fr: Optional[str] = None
    location: Optional[str] = None
    starts_on: Optional[date] = None
    ends_on: Optional[date] = None
    languages: list[Language]
    default_language: Language
    branding: Branding


class EventPublicStats(BaseModel):
    players: int = 0
    games_completed: int = 0


class EventPublic(EventSummary):
    hero_title_en: Optional[str] = None
    hero_title_fr: Optional[str] = None
    settings: EventSettingsPublic
    categories: list[CategoryPublic] = []
    stats: EventPublicStats = Field(default_factory=EventPublicStats)


class EventCounts(BaseModel):
    questions: int = 0
    active_questions: int = 0
    categories: int = 0
    players: int = 0
    games_completed: int = 0


class EventAdmin(EventSummary):
    id: int
    hero_title_en: Optional[str] = None
    hero_title_fr: Optional[str] = None
    settings: EventSettings
    counts: EventCounts = Field(default_factory=EventCounts)
    created_at: UTCDateTime
    updated_at: UTCDateTime


class EventCreate(BaseModel):
    slug: Slug
    name: EventName
    game_title: GameTitle
    status: EventStatus = "draft"
    hero_title_en: OptText200 = None
    hero_title_fr: OptText200 = None
    tagline_en: OptText300 = None
    tagline_fr: OptText300 = None
    description_en: OptText4000 = None
    description_fr: OptText4000 = None
    location: OptText200 = None
    starts_on: Optional[date] = None
    ends_on: Optional[date] = None
    languages: Languages = ["en", "fr"]
    default_language: Language = "en"
    branding: Branding = Field(default_factory=Branding)
    settings: EventSettings = Field(default_factory=EventSettings)

    @model_validator(mode="after")
    def _check_combo(self):
        _check_event_combo(self.languages, self.default_language, self.starts_on, self.ends_on)
        return self


class EventUpdate(PatchModel):
    """Partial update (PUT). ``branding`` / ``settings`` are merged key by key."""

    non_nullable: ClassVar[frozenset[str]] = frozenset(
        {"slug", "name", "game_title", "status", "languages", "default_language", "branding", "settings"}
    )

    slug: Optional[Slug] = None
    name: Optional[EventName] = None
    game_title: Optional[GameTitle] = None
    status: Optional[EventStatus] = None
    hero_title_en: OptText200 = None
    hero_title_fr: OptText200 = None
    tagline_en: OptText300 = None
    tagline_fr: OptText300 = None
    description_en: OptText4000 = None
    description_fr: OptText4000 = None
    location: OptText200 = None
    starts_on: Optional[date] = None
    ends_on: Optional[date] = None
    languages: Optional[Languages] = None
    default_language: Optional[Language] = None
    branding: Optional[BrandingUpdate] = None
    settings: Optional[EventSettingsUpdate] = None

    @model_validator(mode="after")
    def _check_combo(self):
        _check_event_combo(self.languages, self.default_language, self.starts_on, self.ends_on)
        return self


class EventDuplicate(BaseModel):
    slug: Slug
    name: EventName
    game_title: Optional[GameTitle] = None
    copy_branding: bool = True
    copy_settings: bool = True
    copy_questions: bool = True


class QuestionStat(BaseModel):
    id: int
    question_text_en: str
    correct_rate: float = Field(..., description="correct answers / answers, ratio 0..1")
    answered: int


class EventStats(BaseModel):
    players: int = 0
    games_completed: int = 0
    games_in_progress: int = 0  # started less than 3 hours ago and not submitted yet
    games_abandoned: int = 0  # status "abandoned", or still "in_progress" 3 hours after the start
    avg_score: float = 0.0
    top_score: int = 0
    avg_correct: float = 0.0
    questions_active: int = 0  # questions a game can draw (active, and in an active category if any)
    hardest_questions: list[QuestionStat] = []
    easiest_questions: list[QuestionStat] = []


# ---------------------------------------------------------------------------------------------
# Players / games (public)
# ---------------------------------------------------------------------------------------------
class PlayerCreate(BaseModel):
    first_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    last_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    email: EmailStr
    phone_number: _opt_text(20) = None
    consent: Optional[bool] = None

    @model_validator(mode="after")
    def _names_are_not_emails(self):
        if "@" in self.first_name or "@" in self.last_name:
            raise ValueError("Name cannot contain @ symbol or be an email address")
        return self


class PlayerResponse(ORMModel):
    id: int
    event_id: int
    first_name: str
    last_name: str
    email: str
    phone_number: Optional[str] = None
    consent_at: Optional[UTCDateTime] = None
    created_at: UTCDateTime


class GameStartRequest(BaseModel):
    player_id: int


class QuestionForGame(ORMModel):
    """A question as sent to players: NEVER the correct answer or the explanation."""

    id: int
    question_format: QuestionFormat
    question_text_en: str
    question_text_fr: Optional[str] = None
    question_type: str = "text"
    media_url: Optional[str] = None
    green_label_en: str
    green_label_fr: str
    red_label_en: str
    red_label_fr: str
    difficulty: int
    category: Optional[CategoryRef] = None


class GameStarted(BaseModel):
    game_session_id: int
    timer_seconds: int
    points_correct: int
    time_bonus_max: int
    questions: list[QuestionForGame]
    submit_token: str = Field(
        ...,
        description="Opaque secret of THIS game (128 bit random, shown once). Send it back when submitting: "
        "JSON field `submit_token` or header `X-Game-Token`. Only its SHA-256 is stored server side.",
    )


class AnswerSubmission(BaseModel):
    question_id: int
    player_answer: Optional[AnswerValue] = None  # null => unanswered
    time_taken: float = Field(0.0, ge=0, le=86_400, allow_inf_nan=False)  # seconds, clamped server side


class GameSubmitRequest(BaseModel):
    answers: list[AnswerSubmission] = Field(..., max_length=100)
    submit_token: Optional[str] = Field(
        None,
        description="The `submit_token` returned when the game was started (the `X-Game-Token` header is "
        "equivalent). Optional while REQUIRE_SUBMIT_TOKEN is off, but a wrong one is always refused.",
    )

    @model_validator(mode="after")
    def _unique_questions(self):
        ids = [a.question_id for a in self.answers]
        if len(ids) != len(set(ids)):
            raise ValueError("answers must not contain the same question twice")
        return self


class GameSessionResponse(ORMModel):
    id: int
    player_id: int
    status: GameStatus
    total_score: int
    correct_answers: int
    wrong_answers: int
    unanswered: int
    started_at: UTCDateTime
    completed_at: Optional[UTCDateTime] = None


class ReviewItem(BaseModel):
    question_id: int
    question_format: QuestionFormat
    question_text_en: str
    question_text_fr: Optional[str] = None
    correct_answer: AnswerValue
    player_answer: Optional[AnswerValue] = None
    is_correct: Optional[bool] = None
    explanation_en: Optional[str] = None
    explanation_fr: Optional[str] = None
    time_taken: Optional[float] = None
    points_earned: int = 0
    green_label_en: str
    green_label_fr: str
    red_label_en: str
    red_label_fr: str
    category: Optional[CategoryRef] = None


class GameComplete(BaseModel):
    game_session: GameSessionResponse
    rank: int
    total_players: int
    review: list[ReviewItem]


class ScoreboardEntry(BaseModel):
    """Public scoreboard row: never e-mail / phone, name shortened to 'First L.'."""

    id: int  # game session id
    rank: int
    player_name: str
    score: int
    correct_answers: int
    wrong_answers: int
    completed_at: Optional[UTCDateTime] = None


class ScoreboardSnapshot(BaseModel):
    """Payload of each SSE message of the scoreboard stream."""

    entries: list[ScoreboardEntry]
    total_players: int
    total_games: int


# ---------------------------------------------------------------------------------------------
# Admin results
# ---------------------------------------------------------------------------------------------
class ResultPlayer(ORMModel):
    id: int
    first_name: str
    last_name: str
    email: str
    phone_number: Optional[str] = None
    consent_at: Optional[UTCDateTime] = None


class ResultSummary(ORMModel):
    id: int
    player: ResultPlayer
    status: GameStatus
    total_score: int
    correct_answers: int
    wrong_answers: int
    unanswered: int
    started_at: UTCDateTime
    completed_at: Optional[UTCDateTime] = None


class ResultPage(BaseModel):
    items: list[ResultSummary]
    total: int


class ResultAnswerDetail(BaseModel):
    question_id: int
    question_text_en: str
    question_text_fr: Optional[str] = None
    green_label_en: str
    red_label_en: str
    correct_answer: AnswerValue
    player_answer: Optional[AnswerValue] = None
    is_correct: Optional[bool] = None
    time_taken: Optional[float] = None
    points_earned: int = 0
    question_order: int


class ResultDetail(ResultSummary):
    answers: list[ResultAnswerDetail] = []


class ScoreUpdate(BaseModel):
    total_score: int = Field(..., ge=0, le=10_000_000)


class ResultsPurged(BaseModel):
    """Answer of ``DELETE /api/admin/events/{id}/results``."""

    deleted_results: int = 0
    deleted_players: int = 0


class ScoreUpdateResult(BaseModel):
    id: int
    total_score: int


# ---------------------------------------------------------------------------------------------
# Event bundle v1 (export / import / seed), strict
# ---------------------------------------------------------------------------------------------
class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BundleCategory(_Strict):
    name: CategoryName
    name_fr: OptText100 = None
    description: OptText2000 = None
    description_fr: OptText2000 = None
    color: HexColor = DEFAULT_PRIMARY_COLOR
    is_active: bool = True


class BundleQuestion(QuestionContent):
    model_config = ConfigDict(extra="forbid")

    category: Optional[CategoryName] = None  # category NAME (None => uncategorised)


class BundleEvent(_Strict):
    slug: Slug
    name: EventName
    game_title: GameTitle
    status: EventStatus = "draft"
    hero_title_en: OptText200 = None
    hero_title_fr: OptText200 = None
    tagline_en: OptText300 = None
    tagline_fr: OptText300 = None
    description_en: OptText4000 = None
    description_fr: OptText4000 = None
    location: OptText200 = None
    starts_on: Optional[date] = None
    ends_on: Optional[date] = None
    languages: Languages
    default_language: Language
    branding: BundleBranding = Field(default_factory=BundleBranding)
    settings: BundleSettings = Field(default_factory=BundleSettings)

    @model_validator(mode="after")
    def _check_combo(self):
        _check_event_combo(self.languages, self.default_language, self.starts_on, self.ends_on)
        return self


class BundleV1(_Strict):
    """``format: gravitee-quiz-event``, ``version: 1`` (see ARCHITECTURE section 6)."""

    format: Literal["gravitee-quiz-event"]
    version: Literal[1]
    event: BundleEvent
    categories: list[BundleCategory] = Field(default_factory=list, max_length=MAX_BUNDLE_CATEGORIES)
    questions: list[BundleQuestion] = Field(default_factory=list, max_length=MAX_BUNDLE_QUESTIONS)

    @model_validator(mode="after")
    def _check_references(self):
        names = [c.name for c in self.categories]
        if len(names) != len(set(names)):
            raise ValueError("category names must be unique")
        known = set(names)
        for index, q in enumerate(self.questions):
            if q.category is not None and q.category not in known:
                raise ValueError(f"questions[{index}].category '{q.category}' is not in categories")
        distribution = self.event.settings.category_distribution
        if distribution:
            unknown = sorted(set(distribution) - known)
            if unknown:
                raise ValueError(f"category_distribution references unknown categories: {unknown}")
        return self


class EventImportRequest(BaseModel):
    bundle: BundleV1
    slug: Optional[Slug] = None  # overrides bundle.event.slug
    name: Optional[EventName] = None
    status: Optional[EventStatus] = None
