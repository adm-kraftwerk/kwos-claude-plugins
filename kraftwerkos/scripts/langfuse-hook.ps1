# langfuse-hook.ps1 — Claude Code Stop hook (Windows)
#
# Reads token counts from the transcript and POSTs them to the kw/OS plugin.
# The server enriches the data with workitem metadata and forwards to Langfuse.
#
# Required env vars (set via server-managed Claude Code settings):
#   KWOS_PLUGIN_URL    Base URL of the plugin server
#   KWOS_HOOKS_SECRET  Shared secret matching the plugin's KWOS_HOOKS_SECRET

$ErrorActionPreference = 'SilentlyContinue'

# ── Read hook input from stdin ───────────────────────────────────────────────

try {
    $raw   = [Console]::In.ReadToEnd()
    $hookInput = $raw | ConvertFrom-Json
} catch {
    exit 0
}

# Guard: never trigger if another Stop hook is already active (prevents loops)
if ($hookInput.stop_hook_active -eq $true) { exit 0 }
if (-not $hookInput.session_id)            { exit 0 }

# Skip trivial turns where Claude produced no response
if (-not $hookInput.last_assistant_message -or
    $hookInput.last_assistant_message.Trim() -eq '') { exit 0 }

# ── Sum token counts from transcript (cumulative across all turns) ────────────

$inputTokens         = 0
$outputTokens        = 0
$cacheCreationTokens = 0
$cacheReadTokens     = 0
$model               = $null

if ($hookInput.transcript_path -and (Test-Path $hookInput.transcript_path)) {
    foreach ($line in (Get-Content -Path $hookInput.transcript_path -Encoding UTF8)) {
        if (-not $line.Trim()) { continue }
        try {
            $entry = $line | ConvertFrom-Json
            if ($entry.type -eq 'assistant' -and $entry.message -and $entry.message.usage) {
                $u = $entry.message.usage
                if ($null -ne $u.input_tokens)                { $inputTokens         += $u.input_tokens }
                if ($null -ne $u.output_tokens)               { $outputTokens        += $u.output_tokens }
                if ($null -ne $u.cache_creation_input_tokens) { $cacheCreationTokens += $u.cache_creation_input_tokens }
                if ($null -ne $u.cache_read_input_tokens)     { $cacheReadTokens     += $u.cache_read_input_tokens }
                if ($entry.message.model)           { $model = $entry.message.model }
            }
        } catch { continue }
    }
}

# ── POST to plugin ───────────────────────────────────────────────────────────

$pluginUrl = $env:KWOS_PLUGIN_URL -replace '/$', ''
if (-not $pluginUrl) { exit 0 }

$payload = @{
    session_id            = $hookInput.session_id
    input_tokens          = $inputTokens
    output_tokens         = $outputTokens
    cache_creation_tokens = $cacheCreationTokens
    cache_read_tokens     = $cacheReadTokens
    model                 = $model
} | ConvertTo-Json -Compress

$headers = @{ 'Content-Type' = 'application/json' }
if ($env:KWOS_HOOKS_SECRET) { $headers['X-Hook-Secret'] = $env:KWOS_HOOKS_SECRET }

try {
    Invoke-RestMethod `
        -Uri     "$pluginUrl/api/trace" `
        -Method  POST `
        -Body    $payload `
        -Headers $headers `
        -TimeoutSec 5 | Out-Null
} catch { }

exit 0
