# Removes the "Terminal Printer (Virtual)" device and its loopback port.
#requires -RunAsAdministrator
param(
  [int]$Port = 9101,
  [string]$Name = "Terminal Printer (Virtual)"
)
$ErrorActionPreference = 'SilentlyContinue'
$portName = "TerminalPrinter_$Port"

Remove-Printer -Name $Name -Confirm:$false
Start-Sleep -Milliseconds 300
Remove-PrinterPort -Name $portName -Confirm:$false

Write-Output "Removed '$Name'"
