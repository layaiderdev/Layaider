#!/usr/bin/env bash
# Layaider validation — syntax-checks the backend (Python) and frontend (JS),
# then runs the guardrail suite. Designed for Debian/Termux (where python3, node,
# git and tmux are present); on other hosts it skips whatever isn't installed.
#
#   scripts/validate.sh
#
# Exit code is non-zero if any check fails.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0

echo "== Python syntax (py_compile) =="
if command -v python3 >/dev/null 2>&1; then
  if python3 -m py_compile main.py src/*.py tests/*.py; then echo "  ok"; else echo "  FAIL"; fail=1; fi
else
  echo "  skipped (no python3)"
fi

echo "== JS syntax (node --check) =="
if command -v node >/dev/null 2>&1; then
  for f in public/*.js; do
    if node --check "$f"; then echo "  ok   $f"; else echo "  FAIL $f"; fail=1; fi
  done
else
  echo "  skipped (no node)"
fi

echo "== Guardrail suite (tests/test_security.py) =="
if command -v python3 >/dev/null 2>&1; then
  python3 tests/test_security.py || fail=1
else
  echo "  skipped (no python3)"
fi

echo
if [ "$fail" = 0 ]; then echo "VALIDATION OK"; else echo "VALIDATION FAILED"; fi
exit "$fail"
