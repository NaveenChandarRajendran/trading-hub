# start_trading_day.ps1 - the owner's morning routine in one go (run by Start_Trading_Day.bat). PAPER ONLY.
# Asks for today's Dhan client ID and access token (hidden; never shown, printed or saved), asks for the MegaBull key
# only when it is missing or older than 25 days (saved in %USERPROFILE%\TradingHubKeys, outside the Trading Journey
# folder and outside git), starts the backend (data, 5-minute signal watcher, auto paper trader) and the frontend,
# checks that Dhan and MegaBull answer, and opens the dashboard. Auto stays ON / OFF as it was last left.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = [IO.Path]::GetFullPath((Join-Path $repo '..\..\Auto Paper Logs'))
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$ist = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'India Standard Time')
$log = Join-Path $logDir ("start_{0:yyyy-MM-dd}.log" -f $ist)

function Say([string]$msg, [string]$color = 'Gray') {
    Write-Host $msg -ForegroundColor $color
    Add-Content -Path $log -Value ("{0:HH:mm:ss} {1}" -f [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'India Standard Time'), $msg)
}
function Plain([Security.SecureString]$s) {
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Get-Api([string]$path) {
    try { return Invoke-RestMethod -Uri ("http://127.0.0.1:8000" + $path) -TimeoutSec 20 } catch { return $null }
}

Write-Host ''
Write-Host '=== Trading Hub: start of the trading day (paper only) ===' -ForegroundColor Cyan
if ($ist.TimeOfDay -ge [TimeSpan]'15:15:00') {
    Say 'Warning: it is after 3:15 PM. No new trades are possible today; the app will only show data.' 'Yellow'
}

# ---- 1. Dhan (typed fresh every day, kept only in this window's memory) ----
do { $cid = (Read-Host 'Dhan Client ID (numbers only)').Trim() } until ($cid -match '^\d+$')
do { $tok = Plain (Read-Host "Paste today's Dhan access token (hidden), then press Enter" -AsSecureString) } until ($tok.Length -ge 20)
$env:DHAN_CLIENT_ID = $cid
$env:DHAN_ACCESS_TOKEN = $tok

# ---- 2. MegaBull key: only when missing or older than 25 days ----
$keyDir = Join-Path $env:USERPROFILE 'TradingHubKeys'
$keyFile = Join-Path $keyDir 'megabull.json'
$needKey = $true
if (Test-Path $keyFile) {
    try {
        $k = Get-Content $keyFile -Raw | ConvertFrom-Json
        $age = ((Get-Date).Date - [DateTime]::Parse($k.createdOn)).Days
        if ($k.apiKey -and $age -le 25) { $needKey = $false } else { Say "The saved MegaBull key is $age days old (it expires after a month)." 'Yellow' }
    } catch { Say 'The saved MegaBull key file could not be read; it will be asked again.' 'Yellow' }
}
if ($needKey) {
    $mb = Plain (Read-Host 'MegaBull API key (hidden; press Enter to skip for now)' -AsSecureString)
    if ($mb.Trim()) {
        New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
        @{ apiKey = $mb.Trim(); createdOn = (Get-Date -Format 'yyyy-MM-dd') } | ConvertTo-Json | Set-Content -Path $keyFile -Encoding UTF8
        Say "MegaBull key saved in $keyDir (outside the Trading Journey folder)." 'Green'
    } else {
        Say 'No MegaBull key: MegaBull stays off today.' 'Yellow'
    }
    $mb = $null
}

# ---- 3. Start the backend and the frontend ----
Say 'Starting the backend (data, signal watcher, auto paper trader) and the frontend...'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'title Trading Hub - Backend (keep open until 3:35 PM) && python main.py' -WorkingDirectory (Join-Path $repo 'backend')
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'title Trading Hub - Frontend (keep open) && npm run dev' -WorkingDirectory (Join-Path $repo 'frontend')
$tok = $null
Remove-Item Env:DHAN_ACCESS_TOKEN -ErrorAction SilentlyContinue

$status = $null
foreach ($i in 1..45) { Start-Sleep -Seconds 2; $status = Get-Api '/api/status'; if ($status) { break } }
if (-not $status) {
    Say 'FAILED: the backend did not start. Look at the Backend window for the error, then tell Claude.' 'Red'
} else {
    $exp = Get-Api '/api/expiries?symbol=NIFTY'
    if ($exp -and $exp.expiries) { Say 'Dhan: OK.' 'Green' }
    else { Say 'FAILED: Dhan did not answer. The client ID or today''s token is probably wrong or expired. Close the Backend window and start again.' 'Red' }
    $chk = Get-Api '/api/autopaper/check'
    if ($chk) {
        $c = if ($chk.megabull.ok) { 'Green' } else { 'Yellow' }
        Say ("MegaBull: " + $chk.megabull.message) $c
    }
    $sig = Get-Api '/api/signals/state?symbol=NIFTY'
    if ($sig -and $sig.auto) {
        $word = if ($sig.auto.auto) { 'ON' } else { 'OFF' }
        Say ("Auto is $word (as you last left it). Turn it on or off on the dashboard.") 'Cyan'
    }
}

$front = $false
foreach ($i in 1..30) {
    try { Invoke-WebRequest -Uri 'http://localhost:5173/' -UseBasicParsing -TimeoutSec 3 | Out-Null; $front = $true; break } catch { Start-Sleep -Seconds 2 }
}
if ($front) { Start-Process 'http://localhost:5173/'; Say 'Dashboard opened in the browser.' 'Green' }
else { Say 'FAILED: the frontend did not start. Look at the Frontend window for the error.' 'Red' }

Write-Host ''
Write-Host 'Keep the computer on and the two Trading Hub windows open from 9:15 AM to about 3:35 PM.' -ForegroundColor Cyan
Write-Host 'At the end of the day the logs are in:' $logDir -ForegroundColor Cyan
Write-Host ''
Read-Host 'Press Enter to close this window (the app keeps running)'
