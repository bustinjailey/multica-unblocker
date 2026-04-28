#!/bin/bash
# Install / update multica-unblocker on LXC 122. Idempotent.
# Run from /opt/multica-unblocker as root after `git pull`.
set -euo pipefail

INSTALL_DIR="/opt/multica-unblocker"
ENV_DIR="/etc/multica-unblocker"
SERVICE_NAME="multica-unblocker"
SERVICE_USER="multica"

cd "$INSTALL_DIR"

echo "[install] pnpm install"
pnpm install --prod=false --frozen-lockfile

echo "[install] pnpm build"
pnpm build

mkdir -p "$ENV_DIR"

if [ ! -f "$ENV_DIR/env" ]; then
    cat > "$ENV_DIR/env" <<EOF
# multica-unblocker environment. Seed MULTICA_PAT before starting.
MULTICA_URL=http://localhost:8080
WORKSPACE_SLUG=snapview
MULTICA_PAT=
# How often (ms) to scan blocked issues. 60s is plenty — most blockers clear
# minutes-to-hours after being filed.
POLL_INTERVAL_MS=60000
# Status to put a resumed issue into when we can't recover the previous one
# from the activity log. 'todo' is a safe default — the assignee picks it up.
DEFAULT_RESUME_STATUS=todo
# Health endpoint, localhost-only by default.
LISTEN_PORT=7892
LISTEN_HOST=127.0.0.1
# Set to 'true' to log decisions without acting on them. Flip back to 'false'
# once you're satisfied with what the service would do.
DRY_RUN=true
EOF
    chmod 600 "$ENV_DIR/env"
    chown root:"$SERVICE_USER" "$ENV_DIR/env"
    echo "[install] WROTE TEMPLATE: $ENV_DIR/env — fill MULTICA_PAT before starting"
fi

cp deploy/multica-unblocker.service /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

if grep -q "^MULTICA_PAT=$" "$ENV_DIR/env" 2>/dev/null; then
    echo "[install] env not configured — NOT starting. Edit $ENV_DIR/env and run: systemctl start $SERVICE_NAME"
else
    systemctl restart "$SERVICE_NAME"
    sleep 1
    systemctl --no-pager --lines=20 status "$SERVICE_NAME" || true
fi
