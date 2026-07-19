# session-end.ps1 — Claude Code SessionEnd hook (Windows)
#
# PowerShell counterpart to session-end.sh, registered as the second (powershell)
# hook entry. Forwards the session-end event to the plugin server so it can store
# carry state (workitem_id keyed by hash(cwd)) for persistence across /clear sessions.

$ErrorActionPreference = 'SilentlyContinue'

# Fallback only: when bash is on PATH, the (faster) bash hook entry runs
# session-end.sh and does the work. Exit immediately to avoid double execution
# and to skip PowerShell's slow cold start (which can be cancelled during the
# short SessionEnd teardown window). This entry does the work solely on Windows
# machines without a discoverable bash.
if (Get-Command bash -ErrorAction SilentlyContinue) { exit 0 }

$body = ''
try { $body = [Console]::In.ReadToEnd() } catch { }

$pluginUrl = ($env:KWOS_PLUGIN_URL -replace '/$', '')
if (-not $pluginUrl) { exit 0 }

try {
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($env:KWOS_HOOKS_SECRET) { $headers['X-Hook-Secret'] = $env:KWOS_HOOKS_SECRET }
    Invoke-WebRequest -Uri "$pluginUrl/hooks/session-end" -Method POST `
        -Body $body -Headers $headers -TimeoutSec 5 -UseBasicParsing | Out-Null
} catch { }

exit 0
