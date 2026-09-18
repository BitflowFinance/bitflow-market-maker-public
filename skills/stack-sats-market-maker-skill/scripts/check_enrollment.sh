#!/usr/bin/env bash
# Usage: check_enrollment.sh <SP_ADDRESS>   Prints the enrollment state in plain words.
source "$(dirname "$0")/common.sh"; addr_check "${1:-}"
curl -sf "$CAMPAIGN/$1" | python3 -c '
import json,sys,datetime
addr=sys.argv[1]; s=json.load(sys.stdin)["summary"]
print(f"Enrollment for {addr}")
if s["enrolled"]:
    t=datetime.datetime.fromisoformat(s["enrolledAt"].replace("Z","+00:00"))
    print(f"  ENROLLED in Stack by Trading and Stack by Market Making since {t:%m/%d/%y %H:%M} UTC")
    print("  Only activity after that time is scored for those two tracks.")
else:
    print("  NOT ENROLLED. Sign the enrollment message on app.bitflow.finance/stack-sats before going live.")
    print("  The Daily Stack needs no enrollment; a qualifying swap enters this address on its own.")
' "$1"
