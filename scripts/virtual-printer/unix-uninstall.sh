#!/bin/sh
# Removes the Terminal Printer virtual printer from CUPS (macOS / Linux).
#   sudo sh unix-uninstall.sh [NAME]
NAME="${1:-TerminalPrinter}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: sudo sh unix-uninstall.sh $NAME" >&2
  exit 1
fi

lpadmin -x "$NAME" 2>/dev/null || true
rm -f /usr/lib/cups/backend/terminalprinter
echo "Removed CUPS printer '$NAME'"
