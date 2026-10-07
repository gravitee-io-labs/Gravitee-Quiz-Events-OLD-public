#!/bin/sh
# Gravitee Quiz Events - "web" container entrypoint.
#
# Generates the runtime configuration from the environment, then hands over to the
# stock nginx entrypoint:
#   * <runtime dir>/config.js        window.QUIZ_CONFIG = { apiBase: "...", publicBaseUrl: "..." }   (served at /config.js)
#   * /etc/nginx/quiz-runtime.conf   CSP connect-src value (only the API origin if it is not same-origin)
#
# API_BASE_URL  default "/api". Either a same-origin path ("/api") or an absolute
#               http(s) URL ("https://api.example.com/api"). Anything else is rejected
#               and the container refuses to start (a typo must be loud, not silent).
# PUBLIC_BASE_URL  optional, unset by default. The public origin the scoreboard QR code and the printed short URL
#               point to, as seen by the players (e.g. "https://quiz.events.gravitee.io"), for when the page is
#               opened from another address (an internal URL, a LAN IP, a staging host). Must be an http(s) origin
#               WITHOUT a path, query or credentials; a trailing "/" is tolerated and dropped. Anything else is
#               rejected and the container refuses to start. Unset or empty: the clients use location.origin.
#               Becomes window.QUIZ_CONFIG.publicBaseUrl (read by /shared/js/config.js).
#
# The HTML directory is never written to, so it can be a read-only bind mount in dev.
set -eu

RUNTIME_DIR="${QUIZ_RUNTIME_DIR:-/usr/share/nginx/runtime}"
NGINX_RUNTIME_CONF="${QUIZ_NGINX_RUNTIME_CONF:-/etc/nginx/quiz-runtime.conf}"
API_BASE_URL="${API_BASE_URL:-/api}"

log() { echo "[quiz-entrypoint] $*"; }
die() { echo "[quiz-entrypoint] ERROR: $*" >&2; exit 1; }

# --- validate API_BASE_URL -------------------------------------------------------------------
# grep below is line oriented: a value holding a newline would pass line by line and could then
# smuggle a second line into config.js / the nginx CSP value. Refuse control characters up front.
case "$API_BASE_URL" in
  *[![:print:]]*) die "API_BASE_URL must not contain control characters or newlines" ;;
esac
api="$API_BASE_URL"
# strip trailing slashes ("/api/" -> "/api")
while [ "${api%/}" != "$api" ]; do api="${api%/}"; done
[ -n "$api" ] || die "API_BASE_URL must not be empty or '/' (got '$API_BASE_URL')"

case "$api" in
  *..*) die "API_BASE_URL must not contain '..' (got '$API_BASE_URL')" ;;
  //*)  die "API_BASE_URL must not be protocol-relative (got '$API_BASE_URL')" ;;
esac

origin=""
case "$api" in
  /*)
    printf '%s' "$api" | grep -Eq '^/[A-Za-z0-9._~/%+-]*$' \
      || die "API_BASE_URL path contains unsafe characters (got '$API_BASE_URL')"
    ;;
  http://*|https://*)
    printf '%s' "$api" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/%+-]*)?$' \
      || die "API_BASE_URL is not a valid http(s) URL (got '$API_BASE_URL')"
    origin="$(printf '%s' "$api" | sed -E 's#^(https?://[^/]+).*#\1#')"
    ;;
  *)
    die "API_BASE_URL must be a path starting with '/' or an http(s) URL (got '$API_BASE_URL')"
    ;;
esac

# --- validate PUBLIC_BASE_URL (optional) -----------------------------------------------------
public=""
if [ -n "${PUBLIC_BASE_URL:-}" ]; then
  case "$PUBLIC_BASE_URL" in
    *[![:print:]]*) die "PUBLIC_BASE_URL must not contain control characters or newlines" ;;
  esac
  public="$PUBLIC_BASE_URL"
  while [ "${public%/}" != "$public" ]; do public="${public%/}"; done
  # scheme://host[:port] and nothing else (no path, query, fragment, userinfo, spaces). Compared in lower case,
  # like location.origin.
  public="$(printf '%s' "$public" | tr 'A-Z' 'a-z')"
  printf '%s' "$public" | grep -Eq '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' \
    || die "PUBLIC_BASE_URL must be an http(s) origin without a path, e.g. https://quiz.events.gravitee.io (got '$PUBLIC_BASE_URL')"
  case "$public" in
    *..*) die "PUBLIC_BASE_URL must not contain '..' (got '$PUBLIC_BASE_URL')" ;;
  esac
  public_port="$(printf '%s' "$public" | sed -nE 's#^https?://[^:/]+:([0-9]+)$#\1#p')"
  if [ -n "$public_port" ] && { [ "$public_port" -lt 1 ] || [ "$public_port" -gt 65535 ]; }; then
    die "PUBLIC_BASE_URL has an invalid port (got '$PUBLIC_BASE_URL')"
  fi
fi

# JSON string escaping (defence in depth: the validation above already excludes these)
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
json_api="$(json_escape "$api")"
public_field=""
if [ -n "$public" ]; then
  public_field=", publicBaseUrl: \"$(json_escape "$public")\""
fi

# --- write runtime files (atomically) -------------------------------------------------------
mkdir -p "$RUNTIME_DIR"
tmp="$RUNTIME_DIR/.config.js.$$"
{
  echo "// Generated at container start from API_BASE_URL / PUBLIC_BASE_URL. Do not edit."
  printf 'window.QUIZ_CONFIG = { apiBase: "%s"%s };\n' "$json_api" "$public_field"
} > "$tmp" || die "cannot write $RUNTIME_DIR (read-only filesystem?)"
chmod 0644 "$tmp"
mv -f "$tmp" "$RUNTIME_DIR/config.js"

if [ -n "$origin" ]; then
  connect_src="'self' $origin"
else
  connect_src="'self'"
fi
tmp="$NGINX_RUNTIME_CONF.$$"
# shellcheck disable=SC2016  # the nginx variable must stay literal
printf 'set $quiz_connect_src "%s";\n' "$connect_src" > "$tmp" || die "cannot write $NGINX_RUNTIME_CONF"
chmod 0644 "$tmp"
mv -f "$tmp" "$NGINX_RUNTIME_CONF"

log "apiBase=$api  publicBaseUrl=${public:-<unset: location.origin>}  connect-src=$connect_src"

# --- hand over to nginx (through the stock entrypoint when present) ----------------------------
if [ -x /docker-entrypoint.sh ]; then
  exec /docker-entrypoint.sh "$@"
fi
exec "$@"
