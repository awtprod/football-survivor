#!/usr/bin/env bash
# Remove the Football Survivor PWA services and withdraw ONLY its dedicated
# Tailscale Service. This never touches this node's own `tailscale serve`
# config (the report at the node root is left exactly as it is).
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="football-survivor"
TAILSCALE_BIN="$(command -v tailscale || true)"

systemctl --user disable --now \
  football-survivor-tailscale.timer \
  football-survivor-tailscale.service \
  football-survivor.service 2>/dev/null || true

# Withdraw just svc:football-survivor.
if [[ -n "$TAILSCALE_BIN" ]]; then
  "$TAILSCALE_BIN" serve --service=svc:${SERVICE_NAME} clear 2>/dev/null || true
fi

rm -f \
  "$UNIT_DIR/football-survivor.service" \
  "$UNIT_DIR/football-survivor-tailscale.service" \
  "$UNIT_DIR/football-survivor-tailscale.timer"

systemctl --user daemon-reload
echo "Removed units and cleared svc:${SERVICE_NAME}."
echo "The service definition still exists in the admin console — delete it there if you want it fully gone."
