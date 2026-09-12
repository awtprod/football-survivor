#!/usr/bin/env bash
# Install the dedicated Tailscale Service for the Football Survivor PWA.
#
# Renders the systemd user unit templates in this directory, installs them to
# ~/.config/systemd/user/, and enables:
#   - football-survivor.service          (the Node app on 127.0.0.1:3910)
#   - football-survivor-tailscale.service (asserts svc:football-survivor)
#   - football-survivor-tailscale.timer  (re-asserts it every 5 min)
#
# Idempotent: re-run it any time (after a git pull, or to re-apply the serve
# config). It does NOT touch this node's own `tailscale serve` config, so it
# will never disturb the report served at the node root.
#
# One-time prerequisites (see deploy/README.md for the full walkthrough):
#   1. The host must be a TAGGED node (Services require tag-based identity).
#   2. `tailscale set --operator=$USER` so this user can run `tailscale serve`.
#   3. After first run, APPROVE svc:football-survivor in the admin console and
#      add a grant so you can reach it (deploy/policy-grant.hujson).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

SERVICE_NAME="football-survivor"          # Tailscale Service short name -> svc:football-survivor
NODE_BIN="$(command -v node || true)"
TAILSCALE_BIN="$(command -v tailscale || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: 'node' not found on PATH. Install Node (>=20) first." >&2
  exit 1
fi
if [[ -z "$TAILSCALE_BIN" ]]; then
  echo "error: 'tailscale' not found on PATH. Install Tailscale first." >&2
  exit 1
fi

# Derive the tailnet DNS suffix (e.g. tailbd9828.ts.net) from this node's
# MagicDNS name, so the rendered VAPID_SUBJECT points at the real tailnet.
# Override by exporting TAILNET=... before running.
if [[ -z "${TAILNET:-}" ]]; then
  DNSNAME="$("$TAILSCALE_BIN" status --json 2>/dev/null \
    | grep -o '"DNSName"[^,]*' | head -1 | cut -d'"' -f4 || true)"   # e.g. openclaw-server.tailbd9828.ts.net.
  DNSNAME="${DNSNAME%.}"
  TAILNET="${DNSNAME#*.}"                                            # strip the hostname label
fi
if [[ -z "${TAILNET:-}" || "$TAILNET" != *.* ]]; then
  echo "warn: could not auto-detect the tailnet name; defaulting to tailbd9828.ts.net." >&2
  echo "      Re-run with TAILNET=your-tailnet.ts.net to override." >&2
  TAILNET="tailbd9828.ts.net"
fi

echo "App dir     : $APP_DIR"
echo "Tailnet     : $TAILNET"
echo "Service host: football-survivor.$TAILNET  (svc:$SERVICE_NAME)"
echo "node        : $NODE_BIN"
echo "tailscale   : $TAILSCALE_BIN"
echo "Units -> $UNIT_DIR"
echo

render() {  # render <template> <dest>
  sed -e "s#__APP_DIR__#${APP_DIR}#g" \
      -e "s#__TAILNET__#${TAILNET}#g" \
      -e "s#__NODE_BIN__#${NODE_BIN}#g" \
      -e "s#__TAILSCALE_BIN__#${TAILSCALE_BIN}#g" \
      "$1" > "$2"
}

mkdir -p "$UNIT_DIR"
render "$SCRIPT_DIR/football-survivor.service"            "$UNIT_DIR/football-survivor.service"
render "$SCRIPT_DIR/football-survivor-tailscale.service"  "$UNIT_DIR/football-survivor-tailscale.service"
cp     "$SCRIPT_DIR/football-survivor-tailscale.timer"    "$UNIT_DIR/football-survivor-tailscale.timer"

systemctl --user daemon-reload
systemctl --user enable --now football-survivor.service
systemctl --user enable --now football-survivor-tailscale.service
systemctl --user enable --now football-survivor-tailscale.timer

echo
echo "Installed and started. Current state:"
systemctl --user --no-pager --plain status \
  football-survivor.service football-survivor-tailscale.service football-survivor-tailscale.timer \
  | sed -n '1,4p;/Active:/p' || true

cat <<EOF

Next (one-time, in the Tailscale admin console):
  1. Approve the advertised service 'svc:${SERVICE_NAME}' (Services page).
  2. Add an access grant so you can reach it — see deploy/policy-grant.hujson.

Then open:  https://football-survivor.${TAILNET}
On iPhone:  Safari -> Share -> Add to Home Screen, then Settings -> Enable push.

Note: this is a new origin (was the node root). Re-add the PWA to your Home
Screen once and re-enable push there.

Verify the dedicated endpoint (leaves the node root serve config untouched):
  tailscale serve --service=svc:${SERVICE_NAME} status
EOF
