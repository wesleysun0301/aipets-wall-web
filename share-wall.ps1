$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$cf = Join-Path $env:LOCALAPPDATA "aipets-wall\cloudflared.exe"
if (-not (Test-Path $cf)) {
  Write-Host "missing cloudflared"
  exit 1
}
$listen = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "py -3 -u server.py || python -u server.py" -WorkingDirectory $root
  Start-Sleep -Seconds 2
}
$pwPath = Join-Path $root "password.txt"
if (Test-Path $pwPath) {
  $pw = (Get-Content -Raw -Encoding UTF8 $pwPath).Trim()
  Write-Host "password: $pw"
}
$urlFile = Join-Path $root "public-url.txt"
$ErrorActionPreference = "Continue"
& $cf tunnel --url http://127.0.0.1:8765 2>&1 | ForEach-Object {
  $line = $_.ToString()
  Write-Host $line
  if ($line -match "https://[a-z0-9-]+\.trycloudflare\.com") {
    $url = $Matches[0].TrimEnd("/") + "/"
    [System.IO.File]::WriteAllText($urlFile, $url)
    Write-Host "public: $url"
  }
}
