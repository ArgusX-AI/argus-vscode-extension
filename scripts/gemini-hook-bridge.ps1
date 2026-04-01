# Gemini CLI hook bridge - translates command-based hooks to HTTP POSTs for Argus.
param(
    [Parameter(Position = 0, Mandatory)]
    [string]$EventName,
    [Parameter(Position = 1, Mandatory)]
    [string]$ServerUrl
)
$payload = [Console]::In.ReadToEnd()
$user = if ($env:USERNAME) { $env:USERNAME } else { "unknown" }
try {
    Invoke-RestMethod -Uri "$ServerUrl/hooks/$EventName" `
        -Method Post -ContentType "application/json" `
        -Headers @{ "X-Argus-User" = $user; "X-Argus-Source" = "gemini-cli" } `
        -Body $payload -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}
Write-Output '{}'
exit 0
