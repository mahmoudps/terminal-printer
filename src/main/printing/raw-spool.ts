import { spawn } from 'node:child_process'
import { writeTempFile, removeQuietly } from '../util/paths'
import type { Logger } from '../util/log'

/**
 * Send RAW bytes straight to a Windows print queue (bypassing the driver's
 * rendering) — used for ESC/POS over a USB/shared queue and for ZPL/EPL labels.
 *
 * Implemented with a P/Invoke into winspool.drv via .NET, driven by PowerShell.
 * This deliberately avoids a native node-gyp module so `npm install` needs no
 * Visual Studio build tools.
 */

// C# RawPrinterHelper. Must contain no backticks or ${...} (it lives in a JS
// template literal) and no single-quote-at-column-0 before the real terminator.
const CS_HELPER = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class TPRawPrinter {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
  '  public struct DOCINFOW {',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;',
  '  }',
  '  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]',
  '  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);',
  '  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]',
  '  public static extern bool ClosePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]',
  '  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOW di);',
  '  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]',
  '  public static extern bool EndDocPrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]',
  '  public static extern bool StartPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]',
  '  public static extern bool EndPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]',
  '  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);',
  '  public static void SendBytes(string printer, byte[] bytes) {',
  '    IntPtr h;',
  '    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed: " + Marshal.GetLastWin32Error());',
  '    try {',
  '      DOCINFOW di = new DOCINFOW();',
  '      di.pDocName = "Terminal Printer";',
  '      di.pDataType = "RAW";',
  '      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());',
  '      try {',
  '        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed: " + Marshal.GetLastWin32Error());',
  '        IntPtr p = Marshal.AllocHGlobal(bytes.Length);',
  '        try {',
  '          Marshal.Copy(bytes, 0, p, bytes.Length);',
  '          int written;',
  '          if (!WritePrinter(h, p, bytes.Length, out written)) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());',
  '        } finally { Marshal.FreeHGlobal(p); }',
  '        EndPagePrinter(h);',
  '      } finally { EndDocPrinter(h); }',
  '    } finally { ClosePrinter(h); }',
  '  }',
  '}',
].join('\n')

function buildScript(): string {
  // Printer name + file path arrive via env vars to avoid any injection into
  // the script text.
  return [
    "$ErrorActionPreference = 'Stop'",
    '$printer = $env:TP_PRINTER',
    '$file = $env:TP_FILE',
    "$src = @'",
    CS_HELPER,
    "'@",
    'Add-Type -TypeDefinition $src -Language CSharp',
    '$bytes = [System.IO.File]::ReadAllBytes($file)',
    '[TPRawPrinter]::SendBytes($printer, $bytes)',
    "Write-Output 'OK'",
  ].join('\n')
}

export async function rawSpool(printerName: string, data: Buffer, log: Logger): Promise<void> {
  if (!printerName) throw new Error('raw spool requires a printer name')
  const file = await writeTempFile(data, '.bin')
  try {
    await runPowerShell(buildScript(), { TP_PRINTER: printerName, TP_FILE: file })
    log.debug(`raw spooled ${data.length} bytes to "${printerName}"`)
  } finally {
    await removeQuietly(file)
  }
}

function runPowerShell(script: string, extraEnv: Record<string, string>): Promise<string> {
  // -EncodedCommand (UTF-16LE base64) sidesteps all quoting/stdin pitfalls.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...extraEnv }, windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    ps.stdout.on('data', (d) => (stdout += d.toString()))
    ps.stderr.on('data', (d) => (stderr += d.toString()))
    ps.on('error', reject)
    ps.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`powershell exited ${code}: ${(stderr || stdout).trim()}`)),
    )
  })
}
