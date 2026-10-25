# run_backtest.ps1 - the owner's one-click backtest (Run_Backtest.bat). READ ONLY: downloads past market data from
# Dhan (cached in backend\data\backtest, resumes if stopped) and runs backend\backtest.py. No orders anywhere.
# Dhan token: the one saved by Start_Trading_Day when it still works; otherwise asked (hidden) and saved encrypted in
# %USERPROFILE%\TradingHubKeys only after Dhan accepts it. Never printed or saved in the Trading Journey folder.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
function Plain([Security.SecureString]$s) {
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function TokenWorks($cid, $tok) {
    try {
        $h = @{ 'access-token' = $tok; 'client-id' = $cid; 'Content-Type' = 'application/json' }
        Invoke-RestMethod -Uri 'https://api.dhan.co/v2/marketfeed/ltp' -Method POST -Headers $h -Body '{"IDX_I":[13]}' -TimeoutSec 20 | Out-Null
        return $true
    } catch { return $false }
}
$keyDir = Join-Path $env:USERPROFILE 'TradingHubKeys'
$dhanFile = Join-Path $keyDir 'dhan.json'
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
$saved = $null
if (Test-Path $dhanFile) { try { $saved = Get-Content $dhanFile -Raw | ConvertFrom-Json } catch { $saved = $null } }
$cid = if ($saved -and "$($saved.clientId)" -match '^\d+$') { "$($saved.clientId)" } else { (Read-Host 'Dhan Client ID (numbers only)').Trim() }
$tok = $null
if ($saved -and $saved.token) { try { $tok = (Plain ($saved.token | ConvertTo-SecureString)).Trim() } catch { $tok = $null } }
if (-not $tok -or -not (TokenWorks $cid $tok)) {
    $sec = Read-Host "Paste today's Dhan access token (hidden), then press Enter" -AsSecureString
    $tok = (Plain $sec).Trim()
    if (-not (TokenWorks $cid $tok)) {
        Write-Host 'Dhan did not accept this token (expired, or not copied in full). Generate a new one, use its Copy button, run again.' -ForegroundColor Red
        exit 1
    }
    $enc = ConvertTo-SecureString $tok -AsPlainText -Force | ConvertFrom-SecureString
    @{ clientId = $cid; token = $enc; savedAt = (Get-Date -Format 's') } | ConvertTo-Json | Set-Content -Path $dhanFile -Encoding UTF8
}
Write-Host 'Dhan token OK.' -ForegroundColor Green
$env:DHAN_CLIENT_ID = $cid
$env:DHAN_ACCESS_TOKEN = $tok
Set-Location (Join-Path $repo 'backend')
$log = Join-Path $repo 'backend\data\backtest\run.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Write-Host ''
Write-Host 'Step 1 of 2: downloading 5 years of past data (first time 2-3 hours; you can leave it running).' -ForegroundColor Cyan
Write-Host 'Keep this window open. If it stops, just run it again: it continues where it left off.' -ForegroundColor Cyan
python backtest.py download 2>&1 | Tee-Object -FilePath $log
Write-Host ''
Write-Host 'Step 2 of 2: running the backtest (a few minutes)...' -ForegroundColor Cyan
python backtest.py run 2>&1 | Tee-Object -FilePath $log -Append
$tok = $null
Remove-Item Env:DHAN_ACCESS_TOKEN -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Backtest finished. Tell Claude "done": Claude reads the results by itself.' -ForegroundColor Green
