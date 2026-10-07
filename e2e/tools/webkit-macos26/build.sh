#!/usr/bin/env bash
# Builds the launcher that makes Playwright's bundled WebKit start on macOS 26 and prints the path to export:
#   export WEBKIT_EXECUTABLE="$(e2e/tools/webkit-macos26/build.sh)"
# Only needed when `npx playwright test --project=webkit-mobile` dies with "Segmentation fault" at browser launch.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
out="$here/.build"
mkdir -p "$out"
webkit_dir="$(ls -d "$HOME"/Library/Caches/ms-playwright/webkit-* 2>/dev/null | sort -V | tail -1)"
[ -n "$webkit_dir" ] || { echo "Playwright WebKit is not installed (npx playwright install webkit)" >&2; exit 1; }
clang -dynamiclib -framework Foundation -o "$out/shim.dylib" "$here/shim.m"
cat > "$out/pw_run_shim.sh" <<LAUNCH
#!/usr/bin/env bash
D="$webkit_dir"
DYLD_FRAMEWORK_PATH="\$D" DYLD_LIBRARY_PATH="\$D" DYLD_INSERT_LIBRARIES="$out/shim.dylib" exec "\$D/Playwright.app/Contents/MacOS/Playwright" "\$@"
LAUNCH
chmod +x "$out/pw_run_shim.sh"
echo "$out/pw_run_shim.sh"
