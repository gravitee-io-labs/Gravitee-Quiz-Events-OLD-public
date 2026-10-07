#!/usr/bin/env python3
"""Tests for quizctl.py: argument parsing, credentials rules and the whole HTTP layer.

No backend needed: a small in-process fake of the admin API (ARCHITECTURE.md section 5.3) records
every request, so the exact paths, query strings and bodies quizctl sends can be asserted.
When the real backend is available, `python3 scripts/quizctl.py events` against it is the
complement of this test (see scripts/README.md).

    python3 -m unittest scripts/test_quizctl.py -v       (from the repository root)
    python3 scripts/test_quizctl.py
"""
import contextlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import quizctl  # noqa: E402

TOKEN = "test-token-1"
BUNDLE = {
    "format": "gravitee-quiz-event", "version": 1,
    "event": {"slug": "ai-demo", "name": "AI Demo", "game_title": "AI Masters", "status": "draft"},
    "categories": [{"name": "LLMs"}],
    "questions": [{"category": "LLMs", "question_text_en": "Q?"}],
}


class FakeAdminApi:
    """Minimal in-memory implementation of the admin endpoints quizctl uses."""

    def __init__(self):
        self.requests = []          # (method, path, query dict, body bytes, headers)
        self.events = [
            {"id": 1, "slug": "api-masters", "name": "API Masters", "game_title": "API Masters", "status": "live",
             "counts": {"questions": 40, "active_questions": 38, "categories": 4, "players": 12, "games_completed": 9}},
            {"id": 2, "slug": "world-ai-summit-2026", "name": "World AI Summit", "game_title": "AI Masters",
             "status": "draft",
             "counts": {"questions": 60, "active_questions": 60, "categories": 5, "players": 0, "games_completed": 0}},
        ]
        self.results = list(range(100, 350))     # 250 game session ids -> three pages of 100
        self.expire_next_token = False
        self.password = "pw"
        self.login_count = 0

    def start(self):
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _read(self):
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n) if n else b""

            def _send(self, code, payload=None, ctype="application/json", raw=None, headers=None):
                body = raw if raw is not None else (b"" if payload is None else json.dumps(payload).encode())
                self.send_response(code)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                if body:
                    self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle(self, method):
                parsed = urlparse(self.path)
                query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                body = self._read()
                api.requests.append((method, parsed.path, query, body, dict(self.headers)))
                path = parsed.path
                if path == "/api/auth/login":
                    creds = json.loads(body)
                    if creds.get("password") != api.password:
                        return self._send(401, {"detail": "Incorrect username or password"})
                    api.login_count += 1
                    return self._send(200, {"access_token": TOKEN, "token_type": "bearer"})
                if path == "/html-me/auth/login":      # a web server (not the API) answering, e.g. URL without /api
                    return self._send(404, ctype="text/html", raw=b"<!doctype html><html><body>404</body></html>")
                if path == "/redirect-me/auth/login":
                    return self._send(301, headers={"Location": "https://example.invalid/api/auth/login"})
                if self.headers.get("Authorization") != f"Bearer {TOKEN}" or api.expire_next_token:
                    api.expire_next_token = False
                    return self._send(401, {"detail": "Not authenticated"})
                m = re.fullmatch(r"/api/admin/events(?:/(\d+))?(?:/(\w[\w.-]*))?(?:/(\w[\w-]*))?", path)
                if path == "/api/admin/events" and method == "GET":
                    return self._send(200, api.events)
                if path == "/api/admin/events/import" and method == "POST":
                    req = json.loads(body)
                    slug = req.get("slug") or req["bundle"]["event"]["slug"]
                    if any(e["slug"] == slug for e in api.events):
                        return self._send(409, {"detail": "slug_conflict"})
                    ev = {"id": 9, "slug": slug, "name": req.get("name") or req["bundle"]["event"]["name"],
                          "status": req.get("status") or "draft",
                          "counts": {"questions": 1, "active_questions": 1, "categories": 1}}
                    return self._send(201, ev)
                if m and m.group(1):
                    eid, sub, sub2 = int(m.group(1)), m.group(2), m.group(3)
                    if sub == "export" and method == "GET":
                        return self._send(200, BUNDLE)
                    if sub == "duplicate" and method == "POST":
                        req = json.loads(body)
                        if req["slug"] == "taken":
                            return self._send(409, {"detail": "slug_conflict"})
                        return self._send(201, {"id": 10, "slug": req["slug"], "name": req["name"],
                                                "status": "draft", "counts": {}})
                    if sub == "stats" and method == "GET":
                        return self._send(200, {"players": 12, "games_completed": 9, "games_in_progress": 1,
                                                "avg_score": 812.5, "top_score": 1490, "avg_correct": 9.1,
                                                "questions_active": 38,
                                                "hardest_questions": [{"id": 5, "question_text_en": "Hard one",
                                                                       "correct_rate": 0.2, "answered": 10}],
                                                "easiest_questions": []})
                    if sub == "results.csv" and method == "GET":
                        return self._send(200, ctype="text/csv", raw=b"rank,first_name\n1,Ada\n")
                    if sub == "results" and method == "GET":
                        skip, limit = int(query.get("skip", 0)), int(query.get("limit", 20))
                        ids = api.results[skip:skip + limit]
                        return self._send(200, {"items": [{"id": i} for i in ids], "total": len(api.results)})
                    if sub == "questions" and sub2 == "import-csv" and method == "POST":
                        errors = [{"row": 3, "message": "bad answer"}] if b"BAD" in body else []
                        return self._send(200, {"created": 0 if query.get("dry_run") else 5, "skipped_duplicates": 1,
                                                "categories_created": 1, "errors": errors})
                rm = re.fullmatch(r"/api/admin/results/(\d+)", path)
                if rm and method == "DELETE":
                    sid = int(rm.group(1))
                    if sid in api.results:
                        api.results.remove(sid)
                    return self._send(204)
                return self._send(404, {"detail": "Not Found"})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_DELETE(self):
                self._handle("DELETE")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api"
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def calls(self, method=None, path_prefix=""):
        return [r for r in self.requests if (method is None or r[0] == method) and r[1].startswith(path_prefix)]


def run(argv, env=None, stdin_tty=False):
    """Run quizctl.main() capturing stdout/stderr; returns (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    environ = {k: v for k, v in os.environ.items() if not k.startswith("QUIZ_")}
    environ.update(env or {})
    with mock.patch.dict(os.environ, environ, clear=True), \
            mock.patch("sys.stdin.isatty", return_value=stdin_tty), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = quizctl.main(argv)
        except SystemExit as exc:           # argparse errors
            code = exc.code
    return code, out.getvalue(), err.getvalue()


class ArgumentParsing(unittest.TestCase):
    def parse(self, *argv):
        return quizctl.build_parser().parse_args(list(argv))

    def test_every_subcommand_parses(self):
        a = self.parse("events", "--json")
        self.assertEqual((a.command, a.json), ("events", True))
        a = self.parse("export", "api-masters", "-o", "x.json")
        self.assertEqual((a.event, a.output), ("api-masters", "x.json"))
        a = self.parse("import", "b.json", "--slug", "s", "--name", "N", "--status", "live")
        self.assertEqual((a.bundle, a.slug, a.name, a.status), ("b.json", "s", "N", "live"))
        a = self.parse("duplicate", "3", "--slug", "new", "--name", "New", "--no-questions")
        self.assertEqual((a.event, a.slug, a.no_questions, a.no_branding), ("3", "new", True, False))
        a = self.parse("import-csv", "ev", "q.csv", "--dry-run")
        self.assertEqual((a.event, a.csv, a.dry_run), ("ev", "q.csv", True))
        a = self.parse("stats", "ev")
        self.assertEqual(a.command, "stats")
        a = self.parse("results-csv", "ev", "-o", "r.csv")
        self.assertEqual(a.output, "r.csv")
        a = self.parse("purge-results", "ev", "--yes", "--confirm", "ev")
        self.assertEqual((a.yes, a.confirm), (True, "ev"))

    def test_global_options_before_command(self):
        a = self.parse("--api-url", "http://x/api", "--user", "u", "--timeout", "5", "events")
        self.assertEqual((a.api_url, a.user, a.timeout), ("http://x/api", "u", 5.0))

    def test_usage_errors_exit_2(self):
        for argv in ([], ["bogus"], ["export"], ["import"], ["duplicate", "x"], ["duplicate", "x", "--slug", "s"],
                     ["import", "b.json", "--status", "weird"], ["import-csv", "ev"]):
            code, _, _ = run(argv)
            self.assertEqual(code, 2, argv)


class Credentials(unittest.TestCase):
    def test_localhost_defaults_to_admin_admin(self):
        for url in ("http://localhost:8080/api", "http://127.0.0.1:8000/api", "http://[::1]:8080/api"):
            self.assertEqual(quizctl.resolve_credentials(url, None, None, interactive=False), ("admin", "admin"), url)

    def test_remote_never_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(quizctl.QuizctlError) as ctx:
                quizctl.resolve_credentials("https://quiz.events.gravitee.io/api", None, None, interactive=False)
            self.assertEqual(ctx.exception.exit_code, 2)

    def test_env_and_flags(self):
        env = {"QUIZ_ADMIN_USER": "bob", "QUIZ_ADMIN_PASSWORD": "pw"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(quizctl.resolve_credentials("https://x.example/api", None, None, False), ("bob", "pw"))
            self.assertEqual(quizctl.resolve_credentials("https://x.example/api", "eve", "s", False), ("eve", "s"))

    def test_invalid_url(self):
        code, _, err = run(["--api-url", "localhost:8080", "events"])
        self.assertEqual(code, 2)
        self.assertIn("invalid API URL", err)


class AgainstFakeApi(unittest.TestCase):
    def setUp(self):
        self.api = FakeAdminApi().start()
        self.addCleanup(self.api.stop)
        self.env = {"QUIZ_API_URL": self.api.url, "QUIZ_ADMIN_USER": "admin", "QUIZ_ADMIN_PASSWORD": "pw"}
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_cli(self, *argv, **kw):
        return run(list(argv), env=self.env, **kw)

    # -- auth ------------------------------------------------------------------------------
    def test_login_sends_credentials_then_bearer(self):
        code, out, _ = self.run_cli("events")
        self.assertEqual(code, 0)
        login = self.api.calls("POST", "/api/auth/login")[0]
        self.assertEqual(json.loads(login[3]), {"username": "admin", "password": "pw"})
        listing = self.api.calls("GET", "/api/admin/events")[0]
        self.assertEqual(listing[4]["Authorization"], f"Bearer {TOKEN}")

    def test_wrong_password(self):
        self.env["QUIZ_ADMIN_PASSWORD"] = "nope"
        code, _, err = self.run_cli("events")
        self.assertEqual(code, 1)
        self.assertIn("authentication failed", err)

    def test_expired_token_is_refreshed_once(self):
        self.api.expire_next_token = True
        code, out, _ = self.run_cli("events")
        self.assertEqual(code, 0)
        self.assertEqual(self.api.login_count, 2)
        self.assertIn("api-masters", out)

    def test_unreachable_api(self):
        self.env["QUIZ_API_URL"] = "http://127.0.0.1:1/api"
        code, _, err = self.run_cli("events")
        self.assertEqual(code, 1)
        self.assertIn("cannot reach", err)

    def test_redirect_is_reported(self):
        self.env["QUIZ_API_URL"] = self.api.url.replace("/api", "/redirect-me")
        code, _, err = self.run_cli("events")
        self.assertEqual(code, 1)
        self.assertIn("redirected", err)

    def test_html_answer_hints_at_the_api_url(self):
        self.env["QUIZ_API_URL"] = self.api.url.replace("/api", "/html-me")
        code, _, err = self.run_cli("events")
        self.assertEqual(code, 1)
        self.assertIn("ends with /api", err)
        self.assertNotIn("<html", err)

    def test_invalid_request_is_a_clean_error(self):
        self.env["QUIZ_API_URL"] = "http://:80/api"
        code, _, err = self.run_cli("events")
        self.assertEqual(code, 1)
        self.assertNotIn("Traceback", err)

    # -- commands --------------------------------------------------------------------------
    def test_events_table_and_json(self):
        code, out, _ = self.run_cli("events")
        self.assertEqual(code, 0)
        self.assertIn("world-ai-summit-2026", out)
        self.assertIn("38/40", out)
        code, out, _ = self.run_cli("events", "--json")
        self.assertEqual([e["slug"] for e in json.loads(out)], ["api-masters", "world-ai-summit-2026"])

    def test_export_by_slug_and_id_to_file(self):
        target = Path(self.tmp.name) / "out.json"
        code, _, _ = self.run_cli("export", "api-masters", "-o", str(target))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), BUNDLE)
        self.assertTrue(self.api.calls("GET", "/api/admin/events/1/export"))
        code, out, _ = self.run_cli("export", "2")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["format"], "gravitee-quiz-event")
        self.assertTrue(self.api.calls("GET", "/api/admin/events/2/export"))

    def test_unknown_event(self):
        code, _, err = self.run_cli("stats", "nope")
        self.assertEqual(code, 1)
        self.assertIn("not found", err)
        self.assertIn("api-masters", err)

    def test_import_with_overrides(self):
        bundle = Path(self.tmp.name) / "b.json"
        bundle.write_text(json.dumps(BUNDLE), encoding="utf-8")
        code, out, _ = self.run_cli("import", str(bundle), "--slug", "ai-live", "--name", "AI Live", "--status", "live")
        self.assertEqual(code, 0)
        body = json.loads(self.api.calls("POST", "/api/admin/events/import")[0][3])
        self.assertEqual((body["slug"], body["name"], body["status"]), ("ai-live", "AI Live", "live"))
        self.assertEqual(body["bundle"]["format"], "gravitee-quiz-event")
        self.assertIn("ai-live", out)

    def test_import_without_overrides_sends_only_bundle(self):
        bundle = Path(self.tmp.name) / "b.json"
        bundle.write_text(json.dumps(BUNDLE), encoding="utf-8")
        self.run_cli("import", str(bundle))
        body = json.loads(self.api.calls("POST", "/api/admin/events/import")[0][3])
        self.assertEqual(set(body), {"bundle"})

    def test_import_conflict_and_bad_files(self):
        bundle = Path(self.tmp.name) / "b.json"
        conflicting = json.loads(json.dumps(BUNDLE))
        conflicting["event"]["slug"] = "api-masters"
        bundle.write_text(json.dumps(conflicting), encoding="utf-8")
        code, _, err = self.run_cli("import", str(bundle))
        self.assertEqual(code, 1)
        self.assertIn("already exists", err)
        bad = Path(self.tmp.name) / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.run_cli("import", str(bad))[0], 2)
        bad.write_text(json.dumps({"format": "other"}), encoding="utf-8")
        self.assertEqual(self.run_cli("import", str(bad))[0], 2)
        self.assertEqual(self.run_cli("import", str(Path(self.tmp.name) / "missing.json"))[0], 2)

    def test_duplicate(self):
        code, out, _ = self.run_cli("duplicate", "api-masters", "--slug", "api-days", "--name", "API Days",
                                    "--game-title", "API Masters", "--no-questions")
        self.assertEqual(code, 0)
        call = self.api.calls("POST", "/api/admin/events/1/duplicate")[0]
        self.assertEqual(json.loads(call[3]), {"slug": "api-days", "name": "API Days", "copy_branding": True,
                                               "copy_settings": True, "copy_questions": False,
                                               "game_title": "API Masters"})
        code, _, err = self.run_cli("duplicate", "api-masters", "--slug", "taken", "--name", "x")
        self.assertEqual(code, 1)
        self.assertIn("already used", err)

    def test_import_csv_dry_run_and_real(self):
        csvfile = Path(self.tmp.name) / "q.csv"
        csvfile.write_text("category,question_text_en\nREST,Q?\n", encoding="utf-8")
        code, out, _ = self.run_cli("import-csv", "api-masters", str(csvfile), "--dry-run")
        call = self.api.calls("POST", "/api/admin/events/1/questions/import-csv")[0]
        self.assertEqual(code, 0)
        self.assertEqual(call[2], {"dry_run": "true"})
        self.assertIn("multipart/form-data", call[4]["Content-Type"])
        self.assertIn(b'name="file"; filename="q.csv"', call[3])
        self.assertIn(b"REST,Q?", call[3])
        self.assertIn("DRY RUN", out)
        code, out, _ = self.run_cli("import-csv", "api-masters", str(csvfile))
        self.assertEqual(self.api.calls("POST", "/api/admin/events/1/questions/import-csv")[1][2], {})
        self.assertIn("created 5 questions", out)

    def test_import_csv_row_errors_give_exit_1(self):
        csvfile = Path(self.tmp.name) / "q.csv"
        csvfile.write_text("BAD", encoding="utf-8")
        code, out, _ = self.run_cli("import-csv", "api-masters", str(csvfile))
        self.assertEqual(code, 1)
        self.assertIn("row 3: bad answer", out)

    def test_stats(self):
        code, out, _ = self.run_cli("stats", "api-masters")
        self.assertEqual(code, 0)
        self.assertIn("top score", out)
        self.assertIn("1490", out)
        self.assertIn("Hard one", out)
        code, out, _ = self.run_cli("stats", "api-masters", "--json")
        self.assertEqual(json.loads(out)["stats"]["players"], 12)

    def test_results_csv_is_private(self):
        target = Path(self.tmp.name) / "leads.csv"
        code, _, _ = self.run_cli("results-csv", "api-masters", "-o", str(target))
        self.assertEqual(code, 0)
        self.assertEqual(target.read_bytes(), b"rank,first_name\n1,Ada\n")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    def test_purge_requires_yes_and_matching_slug(self):
        self.assertEqual(self.run_cli("purge-results", "api-masters")[0], 2)
        code, _, err = self.run_cli("purge-results", "api-masters", "--yes", "--confirm", "wrong")
        self.assertEqual(code, 1)
        self.assertEqual(self.api.calls("DELETE"), [])
        # no terminal and no --confirm: refuse instead of hanging on input()
        self.assertEqual(self.run_cli("purge-results", "api-masters", "--yes")[0], 2)
        self.assertEqual(self.api.calls("DELETE"), [])

    def test_purge_deletes_every_page(self):
        code, out, _ = self.run_cli("purge-results", "api-masters", "--yes", "--confirm", "api-masters")
        self.assertEqual(code, 0)
        self.assertEqual(len(self.api.calls("DELETE", "/api/admin/results/")), 250)
        self.assertEqual(self.api.results, [])
        pages = self.api.calls("GET", "/api/admin/events/1/results")
        self.assertEqual([p[2]["skip"] for p in pages], ["0", "100", "200"])
        self.assertIn("purged 250", out)

    def test_purge_typed_slug_at_prompt(self):
        with mock.patch("builtins.input", return_value="api-masters"):
            code, _, _ = self.run_cli("purge-results", "api-masters", "--yes", stdin_tty=True)
        self.assertEqual(code, 0)
        self.assertEqual(self.api.results, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
