#!/bin/sh
# Publication only: source pushes, builds, trust enrollment, and activation are separate.
set -eu
if ! SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) ||
   ! python3 "$SCRIPT_DIR/linux-amd64-publish.py" "$@" 2>/dev/null; then
    printf '%s\n' 'Linux-amd64 publication refused or read-back failed; no automatic release repair is permitted.' >&2
    exit 1
fi
