#!/usr/bin/env bash
# Committed application bytes and independently reviewed recipe bytes only.
set -euo pipefail
set +x
umask 077
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_dir/linux-amd64-receipt.py" build "$@"
