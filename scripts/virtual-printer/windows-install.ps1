# Registers the "Terminal Printer (Virtual)" device on Windows.
#
# Creates a Standard TCP/IP RAW port aimed at the agent's loopback spool
# listener, and a printer on it using the in-box "Generic / Text Only" driver.
# Any app that prints to this printer streams its job to the running agent.
#
# Requires elevation (managing printers is an admin operation). The app launches
# this via "Run as administrator" (UAC).
#requires -RunAsAdministrator
param(
  [int]$Port = 9101,
  [string]$Name = "Terminal Printer (Virtual)"
)
$ErrorActionPreference = 'Stop'
$portName = "TerminalPrinter_$Port"
$driver = "Generic / Text Only"

if (-not (Get-PrinterDriver -Name $driver -ErrorAction SilentlyContinue)) {
  Add-PrinterDriver -Name $driver
}

if (-not (Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue)) {
  Add-PrinterPort -Name $portName -PrinterHostAddress "127.0.0.1" -PortNumber $Port
}

if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) {
  Set-Printer -Name $Name -PortName $portName -DriverName $driver
} else {
  Add-Printer -Name $Name -DriverName $driver -PortName $portName
}

Write-Output "Installed '$Name' -> 127.0.0.1:$Port (port $portName)"
