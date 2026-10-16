#!/bin/sh
# Container-only driver. All diagnostics remain in the disposable runtime.
set -eu
exec timeout --signal=TERM --kill-after=10s 3500s env -i \
  PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/qualification \
  LANG=C LC_ALL=C TZ=UTC \
  python3 /recipe/linux-amd64-qualify.py --inside
