#!/usr/bin/env python3
"""quizctl - command line client for the Gravitee Quiz Events admin API.

Everything goes through the admin REST API (docs/ARCHITECTURE.md section 5.3), the same one the
admin console uses, so it works identically against docker compose and production.

Connection (environment variables, overridable with flags):
    QUIZ_API_URL         default http://localhost:8080/api
    QUIZ_ADMIN_USER      default "admin"  (only when the API URL is localhost)
    QUIZ_ADMIN_PASSWORD  default "admin"  (only when the API URL is localhost);
                         otherwise prompted for when running in a terminal

Commands:
    events                                   list events with their counters
    export <slug|id> [-o FILE]               export an event as a JSON bundle
    import <bundle.json> [--slug S] [--name N] [--status draft|live|closed]
    duplicate <slug|id> --slug S --name N    copy an event (branding, rules, categories, questions)
    import-csv <slug|id> <file.csv> [--dry-run]
    stats <slug|id>                          players, games, scores, hardest / easiest questions
    results-csv <slug|id> [-o FILE]          leads export (names, e-mails, phones, scores)
    purge-results <slug|id> --yes            delete all game results of an event

Examples:
    python3 scripts/quizctl.py events
    python3 scripts/quizctl.py import events/world-ai-summit-2026.json --status live
    QUIZ_API_URL=https://quiz.events.gravitee.io/api python3 scripts/quizctl.py events
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DEFAULT_API_URL = "http://localhost:8080/api"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"}
BUNDLE_FORMAT = "gravitee-quiz-event"
STATUSES = ("draft", "live", "closed")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2


class QuizctlError(Exception):
    """A user-facing failure (printed without a traceback)."""

    def __init__(self, message: str, exit_code: int = EXIT_ERROR):
        super().__init__(message)
        self.exit_code = exit_code


class ApiError(QuizctlError):
    """The API answered with an error status."""

    def __init__(self, status: int, detail: str, method: str, url: str):
        super().__init__(f"{method} {url} -> HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


# --------------------------------------------------------------------------------------------
# HTTP layer: the only place that talks to the network
# --------------------------------------------------------------------------------------------
def format_detail(payload: Any) -> str:
    """Render FastAPI error bodies ({"detail": "..."} or the 422 list) as one readable line."""
    if isinstance(payload, dict) and "detail" in payload:
        payload = payload["detail"]
    if isinstance(payload, list):
        parts = []
        for item in payload:
            if isinstance(item, dict):
                loc = ".".join(str(p) for p in item.get("loc", []) if p != "body")
                parts.append(f"{loc}: {item.get('msg', item)}" if loc else str(item.get("msg", item)))
            else:
                parts.append(str(item))
        return "; ".join(parts)
    return str(payload)


class QuizApi:
    """Thin authenticated client. Every request goes through :meth:`request`."""

    def __init__(self, base_url: str, username: str, password: str, timeout: float = 60.0,
                 session: Optional[requests.Session] = None):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.timeout = timeout
        self.token: Optional[str] = None
        self.session = session or self._new_session()

    @staticmethod
    def _new_session() -> requests.Session:
        session = requests.Session()
        # Retry only idempotent reads on gateway errors; never replay a POST/PUT/DELETE.
        retry = Retry(total=3, connect=2, backoff_factor=0.3, status_forcelist=(502, 503, 504),
                      allowed_methods=frozenset({"GET", "HEAD"}))
        session.mount("http://", HTTPAdapter(max_retries=retry))
        session.mount("https://", HTTPAdapter(max_retries=retry))
        return session

    def url(self, path: str) -> str:
        return f"{self.base_url}/{path.lstrip('/')}"

    def login(self) -> None:
        resp = self._send("POST", "/auth/login", json_body={"username": self.username, "password": self.password},
                          authenticated=False)
        if resp.status_code == 429:
            raise QuizctlError("login throttled by the API (too many failures), retry in a few minutes")
        if resp.status_code in (401, 403):
            raise QuizctlError(f"authentication failed for user '{self.username}' on {self.base_url}")
        self._raise_for_status(resp, "POST", self.url("/auth/login"))
        try:
            self.token = resp.json()["access_token"]
        except (ValueError, KeyError) as exc:
            raise QuizctlError("unexpected login response (no access_token)") from exc

    def _send(self, method: str, path: str, *, params: Optional[dict] = None, json_body: Any = None,
              files: Optional[dict] = None, authenticated: bool = True) -> requests.Response:
        headers = {"Accept": "application/json"}
        if authenticated and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            return self.session.request(method, self.url(path), params=params, json=json_body, files=files,
                                        headers=headers, timeout=self.timeout, allow_redirects=False)
        except requests.exceptions.SSLError as exc:
            raise QuizctlError(f"TLS error talking to {self.base_url}: {exc}") from exc
        except requests.exceptions.ConnectionError as exc:
            reason = re.search(r"\[Errno -?\d+\] ([^)'\"]+)", str(exc))
            raise QuizctlError(f"cannot reach {self.base_url} (is the stack up? check QUIZ_API_URL)"
                               + (f": {reason.group(1).strip()}" if reason else "")) from exc
        except requests.exceptions.Timeout as exc:
            raise QuizctlError(f"timeout after {self.timeout:.0f}s calling {method} {self.url(path)}") from exc
        except requests.exceptions.RequestException as exc:    # anything else (invalid URL, broken stream...)
            raise QuizctlError(f"request to {self.base_url} failed: {exc}") from exc

    @staticmethod
    def _raise_for_status(resp: requests.Response, method: str, url: str) -> None:
        if 300 <= resp.status_code < 400:
            raise QuizctlError(
                f"{method} {url} was redirected to {resp.headers.get('Location')}: "
                "check that QUIZ_API_URL ends with /api and uses the right scheme (http/https)")
        if resp.status_code >= 400:
            try:
                detail = format_detail(resp.json())
            except ValueError:
                text = (resp.text or resp.reason or "").strip()
                if text.lstrip().startswith("<"):    # an HTML page: a web server answered, not the API
                    detail = ("got an HTML page instead of an API answer: check that QUIZ_API_URL ends with /api "
                              "(e.g. https://quiz.events.gravitee.io/api)")
                else:
                    detail = text[:300]
            raise ApiError(resp.status_code, detail, method, url)

    def request(self, method: str, path: str, *, params: Optional[dict] = None, json_body: Any = None,
                files: Optional[dict] = None) -> requests.Response:
        if self.token is None:
            self.login()
        resp = self._send(method, path, params=params, json_body=json_body, files=files)
        if resp.status_code == 401:            # token expired: log in once more, then replay
            self.login()
            resp = self._send(method, path, params=params, json_body=json_body, files=files)
        self._raise_for_status(resp, method, self.url(path))
        return resp

    def json(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = self.request(method, path, **kwargs)
        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except ValueError as exc:
            raise QuizctlError(f"{method} {self.url(path)} did not return JSON") from exc

    # -- admin API (ARCHITECTURE.md section 5.3) ---------------------------------------------
    def list_events(self) -> list[dict]:
        return self.json("GET", "/admin/events")

    def get_event(self, event_id: int) -> dict:
        return self.json("GET", f"/admin/events/{event_id}")

    def export_event(self, event_id: int) -> Any:
        return self.json("GET", f"/admin/events/{event_id}/export")

    def import_event(self, bundle: dict, slug: Optional[str], name: Optional[str], status: Optional[str]) -> dict:
        body: dict[str, Any] = {"bundle": bundle}
        for key, value in (("slug", slug), ("name", name), ("status", status)):
            if value:
                body[key] = value
        return self.json("POST", "/admin/events/import", json_body=body)

    def duplicate_event(self, event_id: int, body: dict) -> dict:
        return self.json("POST", f"/admin/events/{event_id}/duplicate", json_body=body)

    def import_csv(self, event_id: int, filename: str, content: bytes, dry_run: bool) -> dict:
        return self.json("POST", f"/admin/events/{event_id}/questions/import-csv",
                         params={"dry_run": "true"} if dry_run else None,
                         files={"file": (filename, content, "text/csv")})

    def event_stats(self, event_id: int) -> dict:
        return self.json("GET", f"/admin/events/{event_id}/stats")

    def results_csv(self, event_id: int) -> bytes:
        return self.request("GET", f"/admin/events/{event_id}/results.csv").content

    def list_results(self, event_id: int, skip: int, limit: int) -> dict:
        return self.json("GET", f"/admin/events/{event_id}/results",
                         params={"skip": skip, "limit": limit, "order": "recent"})

    def delete_result(self, session_id: int) -> None:
        self.request("DELETE", f"/admin/results/{session_id}")


# --------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------
def is_local_url(api_url: str) -> bool:
    return (urlparse(api_url).hostname or "") in LOCAL_HOSTS or (urlparse(api_url).hostname or "").endswith(".localhost")


def resolve_credentials(api_url: str, user: Optional[str], password: Optional[str],
                        interactive: Optional[bool] = None) -> tuple[str, str]:
    """admin/admin is a dev convenience: assumed for localhost only, never for a remote API."""
    local = is_local_url(api_url)
    user = user or os.environ.get("QUIZ_ADMIN_USER") or ("admin" if local else None)
    password = password or os.environ.get("QUIZ_ADMIN_PASSWORD") or ("admin" if local else None)
    if interactive is None:
        interactive = sys.stdin.isatty()
    if not user and interactive:
        user = input("Admin user: ").strip()
    if not password and interactive:
        password = getpass.getpass(f"Admin password for {user}@{urlparse(api_url).netloc}: ")
    if not user or not password:
        raise QuizctlError(
            f"no credentials for {api_url}: set QUIZ_ADMIN_USER and QUIZ_ADMIN_PASSWORD "
            "(admin/admin is only assumed for localhost)", EXIT_USAGE)
    return user, password


def find_event(api: QuizApi, ref: str) -> dict:
    """Resolve '<slug>' or '<numeric id>' to the event record from /admin/events."""
    events = api.list_events()
    if ref.isdigit():
        for ev in events:
            if ev.get("id") == int(ref):
                return ev
    for ev in events:
        if ev.get("slug") == ref:
            return ev
    available = ", ".join(sorted(str(e.get("slug")) for e in events)) or "(none)"
    raise QuizctlError(f"event '{ref}' not found. Available slugs: {available}")


def write_output(data: bytes, path: Optional[str], private: bool = False) -> None:
    """Write bytes to a file ('-' or None = stdout). Private files (personal data) are created mode 600."""
    if not path or path == "-":
        buffer = getattr(sys.stdout, "buffer", None)
        if buffer is not None:
            buffer.write(data)
            buffer.flush()
        else:                       # stdout replaced by a text stream (tests, embedding)
            sys.stdout.write(data.decode("utf-8", errors="replace"))
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600 if private else 0o644)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    if private:
        os.chmod(path, 0o600)
    print(f"written {path} ({len(data)} bytes)", file=sys.stderr)


def table(rows: Iterable[Iterable[Any]], headers: list[str]) -> str:
    rows = [[("" if c is None else str(c)) for c in r] for r in rows]
    widths = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h) for i, h in enumerate(headers)]
    line = lambda cells: "  ".join(c.ljust(w) for c, w in zip(cells, widths)).rstrip()  # noqa: E731
    return "\n".join([line(headers), line(["-" * w for w in widths]), *(line(r) for r in rows)])


def describe_event(ev: dict) -> str:
    counts = ev.get("counts") or {}
    return (f"#{ev.get('id')} {ev.get('slug')} [{ev.get('status')}] \"{ev.get('name')}\" - "
            f"{counts.get('active_questions', '?')}/{counts.get('questions', '?')} questions, "
            f"{counts.get('categories', '?')} categories")


# --------------------------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------------------------
def cmd_events(api: QuizApi, args: argparse.Namespace) -> int:
    events = api.list_events()
    if args.json:
        print(json.dumps(events, indent=2, ensure_ascii=False))
        return EXIT_OK
    if not events:
        print("no events yet (create one in the admin console or: quizctl import <bundle.json>)")
        return EXIT_OK
    rows = []
    for ev in sorted(events, key=lambda e: (str(e.get("status")), str(e.get("slug")))):
        c = ev.get("counts") or {}
        rows.append([ev.get("id"), ev.get("slug"), ev.get("status"), ev.get("game_title"),
                     f"{c.get('active_questions', 0)}/{c.get('questions', 0)}", c.get("categories", 0),
                     c.get("players", 0), c.get("games_completed", 0)])
    print(table(rows, ["ID", "SLUG", "STATUS", "GAME", "QUESTIONS", "CATEG.", "PLAYERS", "GAMES"]))
    return EXIT_OK


def cmd_export(api: QuizApi, args: argparse.Namespace) -> int:
    ev = find_event(api, args.event)
    bundle = api.export_event(ev["id"])
    data = (json.dumps(bundle, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    write_output(data, args.output)
    return EXIT_OK


def load_bundle(path: str) -> dict:
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise QuizctlError(f"cannot read {path}: {exc}", EXIT_USAGE) from exc
    try:
        bundle = json.loads(raw)
    except ValueError as exc:
        raise QuizctlError(f"{path} is not valid JSON: {exc}", EXIT_USAGE) from exc
    if not isinstance(bundle, dict) or bundle.get("format") != BUNDLE_FORMAT:
        raise QuizctlError(f"{path} is not an event bundle (expected \"format\": \"{BUNDLE_FORMAT}\")", EXIT_USAGE)
    if not isinstance(bundle.get("event"), dict):
        raise QuizctlError(f"{path} has no \"event\" object", EXIT_USAGE)
    return bundle


def cmd_import(api: QuizApi, args: argparse.Namespace) -> int:
    bundle = load_bundle(args.bundle)
    src = bundle["event"]
    print(f"bundle: {src.get('slug')} \"{src.get('name')}\" - {len(bundle.get('categories') or [])} categories, "
          f"{len(bundle.get('questions') or [])} questions")
    try:
        created = api.import_event(bundle, args.slug, args.name, args.status)
    except ApiError as exc:
        if exc.status == 409:
            raise QuizctlError(f"an event with slug '{args.slug or src.get('slug')}' already exists "
                               "(use --slug to import under another slug, or delete the existing event first)") from exc
        raise
    print("imported " + describe_event(created))
    if created.get("status") != "live":
        print("status is not 'live': it is not listed on the hub yet "
              "(set its status to live in the admin console; importing the same bundle again would answer 409)")
    return EXIT_OK


def cmd_duplicate(api: QuizApi, args: argparse.Namespace) -> int:
    ev = find_event(api, args.event)
    body: dict[str, Any] = {"slug": args.slug, "name": args.name,
                            "copy_branding": not args.no_branding, "copy_settings": not args.no_settings,
                            "copy_questions": not args.no_questions}
    if args.game_title:
        body["game_title"] = args.game_title
    try:
        created = api.duplicate_event(ev["id"], body)
    except ApiError as exc:
        if exc.status == 409:
            raise QuizctlError(f"slug '{args.slug}' is already used by another event") from exc
        raise
    print(f"duplicated #{ev['id']} {ev['slug']} ->")
    print("  " + describe_event(created))
    print("  the copy is a draft: review it in the admin console, then publish it")
    return EXIT_OK


def cmd_import_csv(api: QuizApi, args: argparse.Namespace) -> int:
    path = Path(args.csv)
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise QuizctlError(f"cannot read {path}: {exc}", EXIT_USAGE) from exc
    ev = find_event(api, args.event)
    result = api.import_csv(ev["id"], path.name, content, args.dry_run)
    errors = result.get("errors") or []
    prefix = "DRY RUN (nothing written) - would have " if args.dry_run else ""
    print(f"{prefix}created {result.get('created', 0)} questions, "
          f"skipped {result.get('skipped_duplicates', 0)} duplicates, "
          f"{result.get('categories_created', 0)} new categories, {len(errors)} errors")
    for err in errors:
        print(f"  row {err.get('row')}: {err.get('message')}")
    return EXIT_ERROR if errors else EXIT_OK


def cmd_stats(api: QuizApi, args: argparse.Namespace) -> int:
    ev = find_event(api, args.event)
    stats = api.event_stats(ev["id"])
    if args.json:
        print(json.dumps({"event": {"id": ev["id"], "slug": ev["slug"]}, "stats": stats}, indent=2, ensure_ascii=False))
        return EXIT_OK
    print(describe_event(ev))
    for key in ("players", "games_completed", "games_in_progress", "questions_active",
                "avg_score", "top_score", "avg_correct"):
        value = stats.get(key)
        if isinstance(value, float):
            value = round(value, 1)
        print(f"  {key.replace('_', ' '):<18}{value}")
    for title, key in (("hardest questions", "hardest_questions"), ("easiest questions", "easiest_questions")):
        items = stats.get(key) or []
        print(f"\n  {title}:")
        if not items:
            print("    (not enough answers yet)")
        for q in items:
            rate = q.get("correct_rate")
            pct = f"{rate * 100:.0f}%" if isinstance(rate, (int, float)) else "?"
            print(f"    {pct:>4} correct ({q.get('answered')} answers)  #{q.get('id')} {q.get('question_text_en')}")
    return EXIT_OK


def cmd_results_csv(api: QuizApi, args: argparse.Namespace) -> int:
    ev = find_event(api, args.event)
    write_output(api.results_csv(ev["id"]), args.output, private=True)
    return EXIT_OK


def collect_result_ids(api: QuizApi, event_id: int, page: int = 100) -> list[int]:
    ids: list[int] = []
    skip = 0
    while True:
        data = api.list_results(event_id, skip, page)
        items = data.get("items") or []
        ids.extend(int(i["id"]) for i in items)
        skip += len(items)
        if not items or skip >= int(data.get("total", 0)):
            return ids


def cmd_purge_results(api: QuizApi, args: argparse.Namespace) -> int:
    if not args.yes:
        raise QuizctlError("refusing to purge without --yes", EXIT_USAGE)
    ev = find_event(api, args.event)
    ids = collect_result_ids(api, ev["id"])
    print(f"event #{ev['id']} {ev['slug']} \"{ev['name']}\": {len(ids)} game results found "
          "(scores, answers; the scoreboard will be emptied)")
    if not ids:
        print("nothing to purge")
        return EXIT_OK
    typed = args.confirm
    if typed is None:
        if not sys.stdin.isatty():
            raise QuizctlError("not a terminal: pass --confirm <slug> to confirm non-interactively", EXIT_USAGE)
        typed = input(f"Type the event slug ({ev['slug']}) to permanently delete these results: ").strip()
    if typed != ev["slug"]:
        raise QuizctlError("confirmation does not match the slug, nothing was deleted")
    for n, sid in enumerate(ids, 1):
        api.delete_result(sid)
        if n % 25 == 0 or n == len(ids):
            print(f"  deleted {n}/{len(ids)}", file=sys.stderr)
    print(f"purged {len(ids)} results of {ev['slug']}")
    print("note: the players (names, e-mails, phones) are kept: delete the event in the admin console to remove them too")
    return EXIT_OK


COMMANDS = {
    "events": cmd_events, "export": cmd_export, "import": cmd_import, "duplicate": cmd_duplicate,
    "import-csv": cmd_import_csv, "stats": cmd_stats, "results-csv": cmd_results_csv,
    "purge-results": cmd_purge_results,
}


# --------------------------------------------------------------------------------------------
# argument parsing
# --------------------------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="quizctl", description="Gravitee Quiz Events admin CLI",
        epilog="Credentials: QUIZ_ADMIN_USER / QUIZ_ADMIN_PASSWORD (admin/admin assumed for localhost only).")
    parser.add_argument("--api-url", default=None,
                        help=f"API base URL incl. /api (env QUIZ_API_URL, default {DEFAULT_API_URL})")
    parser.add_argument("--user", default=None, help="admin user (env QUIZ_ADMIN_USER)")
    parser.add_argument("--password", default=None,
                        help="admin password (prefer env QUIZ_ADMIN_PASSWORD: flags are visible in `ps`)")
    parser.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout in seconds (default 60)")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND", required=True)

    p = sub.add_parser("events", help="list events with their counters")
    p.add_argument("--json", action="store_true", help="raw JSON")

    p = sub.add_parser("export", help="export an event as a JSON bundle (stdout unless -o)")
    p.add_argument("event", metavar="SLUG|ID")
    p.add_argument("-o", "--output", metavar="FILE", help="output file ('-' = stdout)")

    p = sub.add_parser("import", help="import a JSON bundle as a new event")
    p.add_argument("bundle", metavar="BUNDLE.json")
    p.add_argument("--slug", help="override the bundle's slug")
    p.add_argument("--name", help="override the bundle's event name")
    p.add_argument("--status", choices=STATUSES, help="override the bundle's status (live = listed on the hub)")

    p = sub.add_parser("duplicate", help="duplicate an event (never copies players or results)")
    p.add_argument("event", metavar="SLUG|ID")
    p.add_argument("--slug", required=True, help="slug of the copy")
    p.add_argument("--name", required=True, help="name of the copy")
    p.add_argument("--game-title", help="game title of the copy (default: same as the source)")
    p.add_argument("--no-branding", action="store_true", help="do not copy branding")
    p.add_argument("--no-settings", action="store_true", help="do not copy game rules")
    p.add_argument("--no-questions", action="store_true", help="do not copy categories and questions")

    p = sub.add_parser("import-csv", help="add questions from a CSV file to an event")
    p.add_argument("event", metavar="SLUG|ID")
    p.add_argument("csv", metavar="FILE.csv")
    p.add_argument("--dry-run", action="store_true", help="validate only, write nothing")

    p = sub.add_parser("stats", help="statistics of an event")
    p.add_argument("event", metavar="SLUG|ID")
    p.add_argument("--json", action="store_true", help="raw JSON")

    p = sub.add_parser("results-csv", help="download the leads / results CSV (personal data: file is mode 600)")
    p.add_argument("event", metavar="SLUG|ID")
    p.add_argument("-o", "--output", metavar="FILE", help="output file ('-' or omitted = stdout)")

    p = sub.add_parser("purge-results", help="DELETE every game result of an event (irreversible)")
    p.add_argument("event", metavar="SLUG|ID")
    p.add_argument("--yes", action="store_true", help="required: acknowledge that the data is deleted for good")
    p.add_argument("--confirm", metavar="SLUG", help="type the slug on the command line instead of at the prompt")
    return parser


def main(argv: Optional[list[str]] = None, session: Optional[requests.Session] = None) -> int:
    args = build_parser().parse_args(argv)
    api_url = (args.api_url or os.environ.get("QUIZ_API_URL") or DEFAULT_API_URL).strip()
    parsed = urlparse(api_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        print(f"quizctl: invalid API URL '{api_url}' (expected http(s)://host/api)", file=sys.stderr)
        return EXIT_USAGE
    try:
        user, password = resolve_credentials(api_url, args.user, args.password)
        if parsed.scheme == "http" and not is_local_url(api_url):
            print(f"quizctl: warning: {api_url} is plain http, credentials travel in clear text", file=sys.stderr)
        api = QuizApi(api_url, user, password, timeout=args.timeout, session=session)
        return COMMANDS[args.command](api, args)
    except QuizctlError as exc:
        print(f"quizctl: {exc}", file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        print("\nquizctl: interrupted", file=sys.stderr)
        return 130
    except BrokenPipeError:     # e.g. `quizctl export x | head`
        return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
