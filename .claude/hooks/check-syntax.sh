#!/bin/sh
# PostToolUse hook: parse-check any JS file Claude just wrote.
#
# The Forge has no build step and no linter, so a syntax error in public/*.js
# is not caught by anything until the app is loaded in a browser and the whole
# script silently fails to execute. This closes that gap at the moment of the
# edit: exit 2 feeds the parser error straight back to Claude to fix.
#
# Reads the hook payload as JSON on stdin; only .js files are checked.

payload=$(cat)

file=$(printf '%s' "$payload" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(s);
      process.stdout.write((j.tool_input && j.tool_input.file_path) || "");
    } catch { /* not JSON — nothing to check */ }
  });
' 2>/dev/null)

case "$file" in
  *.js) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0

if ! err=$(node --check "$file" 2>&1); then
  printf 'Syntax error in %s — fix it before continuing:\n%s\n' "$file" "$err" >&2
  exit 2
fi

exit 0
