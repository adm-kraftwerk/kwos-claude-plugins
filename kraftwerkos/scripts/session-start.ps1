# session-start.ps1 - Claude Code SessionStart hook (Windows)
#
# PowerShell counterpart to session-start.sh, registered as the second (powershell)
# hook entry. On Windows machines where no bash is on PATH, the bash entry fails to
# spawn and this script does the work instead. Mirrors session-start.sh:
#   1. Local setup - CLAUDE.md injection + hook scripts copied to ~\.kwos\
#   2. Server call - POST session-start body; emit response (session ID + workitem carry)
#
# NOTE: keep this file pure ASCII. It is launched via Windows PowerShell 5.1, which
# reads BOM-less scripts as ANSI/Windows-1252 - any non-ASCII byte (em dash, box
# drawing, umlaut) corrupts the parse. ASCII-only avoids the whole encoding problem.

$ErrorActionPreference = 'SilentlyContinue'

# Fallback only: when bash is on PATH, the (faster) bash hook entry runs
# session-start.sh and does the work. Exit immediately to avoid double execution
# and to skip PowerShell's slow cold start. This entry does the work solely on
# Windows machines without a discoverable bash.
if (Get-Command bash -ErrorAction SilentlyContinue) { exit 0 }

# Drain stdin first; forwarded to the server verbatim.
$body = ''
try { $body = [Console]::In.ReadToEnd() } catch { }

$marker    = '<!-- kraftwerkOS -->'
$claudeMd  = Join-Path $env:USERPROFILE '.claude\CLAUDE.md'
$kwosDir   = Join-Path $env:USERPROFILE '.kwos'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$instruction = "$marker`n## kw/OS Workitem Tracking`nAt the start of each session, ask the user ""Which kw/OS workitem are you working on?"" then use ToolSearch with query ""setSessionWorkitem"" to load the MCP tool schema, and call it with their workitemId and the session ID from your context. Never use Bash or shell scripts to set the workitem - it is always a deferred MCP tool. Only ask once per session.`n$marker"

# --- 1. Local setup (CLAUDE.md injection + copy hook scripts) ---

$markerCount = 0
if (Test-Path $claudeMd) {
    $markerCount = (Select-String -Path $claudeMd -SimpleMatch $marker -AllMatches).Matches.Count
}
$scriptsPresent = (Test-Path (Join-Path $kwosDir 'langfuse-hook.sh'))      -and
                  (Test-Path (Join-Path $kwosDir 'langfuse-hook.ps1'))     -and
                  (Test-Path (Join-Path $kwosDir 'inject-session-id.sh'))  -and
                  (Test-Path (Join-Path $kwosDir 'inject-session-id.ps1'))

if (-not ($markerCount -eq 2 -and $scriptsPresent)) {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $claudeMd) | Out-Null
        if (Test-Path $claudeMd) {
            $original = Get-Content -Path $claudeMd -Raw -Encoding UTF8
            # [regex]::Escape keeps user content from being read as a pattern.
            $escaped  = [regex]::Escape($marker)
            $cleaned  = $original -replace "(?ms)$escaped.*?$escaped`r?`n?", ''
            $newContent = $cleaned.TrimEnd() + "`n`n" + $instruction + "`n"
        } else {
            $newContent = $instruction + "`n"
        }
        [System.IO.File]::WriteAllText($claudeMd, $newContent, [System.Text.Encoding]::UTF8)
    } catch { }

    try {
        New-Item -ItemType Directory -Force -Path $kwosDir | Out-Null
        Copy-Item -Force -Path (Join-Path $scriptDir 'langfuse-hook.sh')       -Destination $kwosDir
        Copy-Item -Force -Path (Join-Path $scriptDir 'langfuse-hook.ps1')      -Destination $kwosDir
        Copy-Item -Force -Path (Join-Path $scriptDir 'inject-session-id.sh')   -Destination $kwosDir
        Copy-Item -Force -Path (Join-Path $scriptDir 'inject-session-id.ps1')  -Destination $kwosDir
    } catch { }
}

# --- 2. Server call (session registration + carry lookup) ---

$pluginUrl = ($env:KWOS_PLUGIN_URL -replace '/$', '')
if ($pluginUrl) {
    try {
        $headers = @{ 'Content-Type' = 'application/json' }
        if ($env:KWOS_HOOKS_SECRET) { $headers['X-Hook-Secret'] = $env:KWOS_HOOKS_SECRET }
        $resp = Invoke-WebRequest -Uri "$pluginUrl/hooks/session-start" -Method POST `
            -Body $body -Headers $headers -TimeoutSec 5 -UseBasicParsing
        if ($resp -and $resp.Content) { [Console]::Out.Write($resp.Content) }
    } catch { }
}

exit 0
