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

# UTF-8 EXPLIZIT: Windows PowerShell 5.1 liest [Console]::In mit der OEM-Codepage, Claude Code
# schreibt UTF-8. Ein Profilpfad mit Umlaut (C:\Users\Jürgen\…) kam dann als Mojibake an, Test-Path
# scheiterte und der Hook meldete Nullen -- ohne eine Fehlerzeile.
try {
    $stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
    $raw   = $stdinReader.ReadToEnd()
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
    # GESTREAMT UND VORGEFILTERT (gemessen: 21 s und 1,4 GB RSS bei 291 MB, weil die Klammer um
    # Get-Content die ganze Datei materialisierte und JEDE Zeile durch ConvertFrom-Json ging).
    # ReadLines liest zeilenweise, und die billige Textpruefung ueberspringt alles, was kein
    # Assistenten-Eintrag ist -- das ist die grosse Mehrheit der Zeilen.
    $reader = [System.IO.File]::ReadLines($hookInput.transcript_path)
    foreach ($line in $reader) {
        if (-not $line.Trim()) { continue }
        if ($line -notmatch '"type"\s*:\s*"assistant"') { continue }
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

# TLS 1.2 VOR dem HTTPS-POST. Unter Windows PowerShell 5.1 mit .NET Framework < 4.7 ist der
# Vorgabewert Ssl3|Tls; der Handshake scheitert dann, und der catch darunter verschluckt es --
# der Client meldet gar keine Nutzung. Dieselben zwei Zeilen stehen in install.ps1,
# install-windows.ps1, repair.ps1 und kwos-sync.ps1.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

try {
    Invoke-RestMethod `
        -Uri     "$pluginUrl/api/trace" `
        -Method  POST `
        -Body    $payload `
        -Headers $headers `
        -TimeoutSec 5 | Out-Null
} catch { }

exit 0
