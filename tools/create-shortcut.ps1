# Creates (or refreshes) a desktop shortcut "Eve" that starts start-eve.bat with its console minimized.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\create-shortcut.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $root 'start-eve.bat'
$desktop = [Environment]::GetFolderPath('Desktop') # follows OneDrive folder redirection
$lnkPath = Join-Path $desktop 'Eve.lnk'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $bat
$lnk.WorkingDirectory = $root
$lnk.WindowStyle = 7 # minimized: the server console stays out of the way but can still be opened
$lnk.Description = 'E.V.E. voice assistant'
$icon = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$lnk.IconLocation = if ($icon) { "$icon,0" } else { "$env:SystemRoot\System32\shell32.dll,138" }
$lnk.Save()
Write-Output "Created $lnkPath"
