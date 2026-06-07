# Virtual printer — OS registration

These scripts register a **system printer** named *Terminal Printer (Virtual)* that
captures jobs from any desktop app and streams them to the running agent's
**loopback spool listener** (enable it in Settings → Printers → *Virtual printer*).

The agent then routes each captured job per your setting — re-print it to the
agent's **default printer** (great for thermal/receipt printers and POS apps), or
**save** it to a capture folder.

The app's *Install / Remove* buttons run these for you (Windows triggers a UAC
prompt). You can also run them by hand:

## Windows
```powershell
# elevated PowerShell
powershell -ExecutionPolicy Bypass -File windows-install.ps1 -Port 9101
powershell -ExecutionPolicy Bypass -File windows-uninstall.ps1 -Port 9101
```
Uses the in-box **Generic / Text Only** driver on a Standard TCP/IP **RAW** port
aimed at `127.0.0.1:<port>`. No third-party driver, no signing required.

## macOS / Linux (CUPS)
```sh
sudo sh unix-install.sh 9101 TerminalPrinter
sudo sh unix-uninstall.sh TerminalPrinter
```
Installs `cups-backend` as `/usr/lib/cups/backend/terminalprinter` and adds a raw
CUPS queue that forwards jobs to the agent. The backend honours `TP_SPOOL_PORT`
(default `9101`).

## Notes
- The spool listener binds **loopback only** (`127.0.0.1`).
- The **Generic / Text Only** path captures text faithfully (ideal for receipts);
  rich graphics are flattened. A PostScript driver + Ghostscript would preserve
  full graphics — a future enhancement.
- macOS/Linux paths are provided but were **not tested on those OSes** in this build.
