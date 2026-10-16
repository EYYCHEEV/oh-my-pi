#!/bin/sh
# Qualification never builds, resolves dependencies, pulls images, or publishes.
set -eu
exec python3 "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/linux-amd64-qualify.py" "$@"
