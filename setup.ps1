# One-step setup for Eve on Windows: checks requirements, creates the desktop shortcut, runs tests.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$node = (& node -v) 2>$null
if (-not $node -or [int]($node.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node 22 or newer is required (https://nodejs.org).' }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'Claude Code CLI not found. Install it and sign in first.' }
npm test
npm run shortcut
Write-Host 'Eve is ready. Start her with start-eve.bat or the desktop shortcut.'
