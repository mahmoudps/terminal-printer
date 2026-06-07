#!/bin/sh
# Registers the Terminal Printer virtual printer with CUPS (macOS / Linux).
#
# Needs root (copies a backend into /usr/lib/cups/backend and runs lpadmin), so
# run it with sudo:
#   sudo sh unix-install.sh [PORT] [NAME]
set -e
PORT="${1:-9101}"
NAME="${2:-TerminalPrinter}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/cups-backend"
DST="/usr/lib/cups/backend/terminalprinter"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: sudo sh unix-install.sh $PORT $NAME" >&2
  exit 1
fi

cp "$SRC" "$DST"
chmod 700 "$DST"
chown root "$DST" 2>/dev/null || true

# Raw queue: CUPS hands the job to our backend, which forwards it to the agent.
lpadmin -p "$NAME" -v "terminalprinter:/" -E -m raw

echo "Installed CUPS printer '$NAME' -> agent spool port $PORT"
if [ "$PORT" != "9101" ]; then
  echo "NOTE: backend defaults to port 9101. For $PORT, set TP_SPOOL_PORT=$PORT in the CUPS environment,"
  echo "      or edit PORT in $DST."
fi
