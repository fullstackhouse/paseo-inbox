#!/bin/bash
# A throwaway Paseo daemon on :6790 with this plugin and a copy of the live inbox data (no inbox.json,
# so it never starts agents). Open http://127.0.0.1:6767 and use Direct connection to 127.0.0.1:6790.
# Usage: scripts/ui-sandbox.sh start|stop
set -euo pipefail
H=/tmp/inbox-ui
case "${1:-start}" in
  start)
    # Keep the home between runs (its server id stays, so the web client's saved host keeps working);
    # refresh only the inbox data.
    rm -rf "$H/plugin-data/inbox" && mkdir -p "$H/plugin-data/inbox"
    cp "$HOME/.paseo/plugin-data/inbox/state.json" "$H/plugin-data/inbox/"
    cp -r "$HOME/.paseo/plugin-data/inbox/reviews" "$H/plugin-data/inbox/" 2>/dev/null || true
    printf '%s' '{"daemon":{"listen":"127.0.0.1:6790","cors":{"allowedOrigins":["http://127.0.0.1:6767"]},"relay":{"enabled":false}},"pluginsEnabled":true}' > "$H/config.json"
    (PASEO_HOME="$H" env -u PASEO_AGENT_ID paseo daemon run --home "$H" >"$H/daemon.log" 2>&1 &)
    until curl -s -o /dev/null "http://127.0.0.1:6790/"; do sleep 1; done
    env -u PASEO_AGENT_ID paseo plugin install "$(cd "$(dirname "$0")/.." && pwd)" --home "$H" >/dev/null 2>&1 || env -u PASEO_AGENT_ID paseo plugin reload paseo-inbox --home "$H" >/dev/null
    echo "sandbox up on 127.0.0.1:6790"
    ;;
  stop)
    env -u PASEO_AGENT_ID paseo daemon stop --home "$H" >/dev/null 2>&1 || true
    ;;
esac
