#!/bin/sh
# Start, check, and stop the Jev studio for verification, in its own process group.
# Usage: studio.sh start [PORT] | status [PORT] | stop [PORT]
# Writes a log and pid file under artifacts/verify/. Never kills by process name.
set -eu

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
OUT="$ROOT/artifacts/verify"
ACTION=${1:-status}
PORT=${2:-3999}
LOG="$OUT/studio-$PORT.log"
PIDFILE="$OUT/studio-$PORT.pid"
URL="http://127.0.0.1:$PORT"

mkdir -p "$OUT"

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "$ACTION" in
  start)
    if running; then
      echo "already running: pid $(cat "$PIDFILE") on $URL"
      exit 0
    fi
    cd "$ROOT"
    STUDIO_PORT="$PORT" nohup pnpm dev >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    i=0
    while [ $i -lt 180 ]; do
      if curl -fsS -o /dev/null "$URL/"; then
        echo "ready: $URL (pid $(cat "$PIDFILE"), log $LOG)"
        exit 0
      fi
      if ! running; then
        echo "studio exited during startup; last log lines:" >&2
        tail -20 "$LOG" >&2
        exit 1
      fi
      i=$((i + 1))
      sleep 0.5
    done
    echo "timed out after 90s waiting for $URL; see $LOG" >&2
    exit 1
    ;;
  status)
    if running; then
      code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/" || echo 000)
      echo "running: pid $(cat "$PIDFILE") $URL -> HTTP $code"
    else
      echo "not running (no live pid file for port $PORT)"
      exit 1
    fi
    ;;
  stop)
    if ! running; then
      rm -f "$PIDFILE"
      echo "nothing to stop for port $PORT"
      exit 0
    fi
    PID=$(cat "$PIDFILE")
    PGID=$(ps -o pgid= -p "$PID" | tr -d ' ')
    kill -TERM "-$PGID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    i=0
    while [ $i -lt 40 ] && running; do
      i=$((i + 1))
      sleep 0.25
    done
    if running; then
      kill -KILL "-$PGID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
    echo "stopped port $PORT; evidence kept in $OUT"
    ;;
  *)
    echo "usage: studio.sh start|status|stop [PORT]" >&2
    exit 2
    ;;
esac
