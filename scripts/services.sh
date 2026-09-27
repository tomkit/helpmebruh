#!/bin/sh
# Run the eve agent and the iMessage bridge as launchd LaunchAgents on this Mac.
# Both start at login, restart if they crash, and log to ~/Library/Logs.
#   scripts/services.sh install     build the agent, (re)install and start both
#   scripts/services.sh uninstall   stop and remove both
#   scripts/services.sh restart     rebuild the agent and restart both
#   scripts/services.sh status
#   scripts/services.sh logs [agent|bridge]
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UID_DOMAIN="gui/$(id -u)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOGS_DIR="$HOME/Library/Logs"
NODE="$(realpath "$(command -v node)" 2>/dev/null || true)"
[ -x "$NODE" ] || NODE=/opt/homebrew/bin/node
PORT=2000

label() { echo "com.helpmebruh.$1"; }
plist() { echo "$AGENTS_DIR/$(label "$1").plist"; }
log() { echo "$LOGS_DIR/helpmebruh-$1.log"; }

# write_plist <name> <program args...>
write_plist() {
  name=$1; shift
  args=""
  for a in "$@"; do args="$args    <string>$a</string>
"; done
  cat > "$(plist "$name")" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(label "$name")</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(log "$name")</string>
  <key>StandardErrorPath</key><string>$(log "$name")</string>
</dict>
</plist>
PLIST
}

# bootout returns before the job is fully gone; wait so bootstrap doesn't race it.
stop() {
  launchctl bootout "$UID_DOMAIN/$(label "$1")" 2>/dev/null || true
  i=0
  while launchctl print "$UID_DOMAIN/$(label "$1")" >/dev/null 2>&1 && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done
}
start() { launchctl bootstrap "$UID_DOMAIN" "$(plist "$1")"; }

install() {
  mkdir -p "$AGENTS_DIR" "$LOGS_DIR"
  # The agent's sandbox VMs need the microsandbox runtime in ~/.microsandbox.
  (cd "$ROOT" && "$NODE" -e 'import("microsandbox").then(async (m) => { if (!m.isInstalled()) await m.install(); })')
  (cd "$ROOT" && "$NODE" node_modules/eve/bin/eve.js build >/dev/null)
  write_plist agent "$NODE" --env-file-if-exists=.env node_modules/eve/bin/eve.js start --host 127.0.0.1 --port $PORT
  write_plist bridge "$NODE" --env-file-if-exists=.env bridge/bridge.mjs
  for s in agent bridge; do stop $s; start $s; done
  echo "Installed agent (http://127.0.0.1:$PORT) and bridge. node: $NODE"
  echo "The bridge needs Full Disk Access for: $NODE"
}

case "$1" in
  install|restart) install ;;
  uninstall)
    for s in agent bridge; do stop $s; rm -f "$(plist $s)"; done
    echo "Removed agent and bridge services"
    ;;
  status)
    for s in agent bridge; do
      printf '%s: ' "$s"
      launchctl print "$UID_DOMAIN/$(label $s)" 2>/dev/null | awk '/^\tstate =/{st=$3} /^\tpid =/{pid=$3} /last exit code/{sub(/.*= /,""); ec=$0} END{printf "%s pid=%s last-exit=%s\n", st, pid, ec}' || echo "not loaded"
    done
    ;;
  logs) tail -f "$(log "${2:-bridge}")" ;;
  *) echo "usage: $0 install | uninstall | restart | status | logs [agent|bridge]" >&2; exit 1 ;;
esac
