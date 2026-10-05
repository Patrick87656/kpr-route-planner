# Runs tests/run.html in a headless Edge (or Chrome) and prints the report.
# Exit code 0 only if the report ends with "RESULT: PASS".
#   powershell -NoProfile -File tests\run-tests.ps1

# Browsers write harmless diagnostics to stderr; don't let PowerShell turn
# those into terminating errors.
$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$page = Join-Path $root "tests\run.html"

$candidates = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
  Write-Host "No Edge or Chrome found. Looked in:"
  $candidates | ForEach-Object { Write-Host "  $_" }
  exit 1
}

$url = "file:///" + ($page -replace "\\", "/")
# A throwaway profile keeps the run from touching (or being blocked by) the
# user's normal browser profile.
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("kpr-tests-" + [guid]::NewGuid().ToString("N"))

try {
  $dom = & $browser --headless=new --disable-gpu --no-first-run --user-data-dir="$profile" `
    --virtual-time-budget=30000 --dump-dom $url 2>$null | Out-String
} finally {
  if (Test-Path $profile) { Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue }
}

$match = [regex]::Match($dom, '(?s)<pre id="results"[^>]*>(.*?)</pre>')
if (-not $match.Success) {
  Write-Host "Could not find the results in the page output."
  Write-Host $dom
  exit 1
}

$text = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
Write-Host $text

if ($text -match '(?m)^RESULT: PASS') { exit 0 }
exit 1
