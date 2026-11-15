# inject-session-id.ps1 — Claude Code UserPromptSubmit hook (Windows)
#
# Fires on the first user prompt of each session to inject the real Claude Code
# session ID into the conversation via additionalContext. A flag file gates this
# to a single injection per session — subsequent prompts exit in ~1ms.
#
# This script is purely local: no network calls, no prompt content leaves the machine.

$ErrorActionPreference = 'SilentlyContinue'

try {
    $raw       = [Console]::In.ReadToEnd()
    $hookInput = $raw | ConvertFrom-Json
} catch {
    exit 0
}

$sessionId = $hookInput.session_id
if (-not $sessionId) { exit 0 }

# EINE GEBUNDENE SITZUNG WIRD NICHT GEFRAGT. Der Launcher setzt KWOS_WORKITEM, wenn die Sitzung mit
# einem Workitem startet; die dauerhafte Anweisung (session-start.sh) verbietet dort ausdruecklich
# die Rueckfrage und den Aufruf. Der Hook sah die Variable bisher nicht an und draengte in genau
# diesen Sitzungen auf beides -- gemeldet am 2026-08-05 als "fragte trotzdem nach dem Workitem".
if ($env:KWOS_WORKITEM) { exit 0 }

$kwosDir = Join-Path $env:USERPROFILE '.kwos'
$flag    = Join-Path $kwosDir "injected-$sessionId"

# Already injected this session — exit immediately
if (Test-Path $flag) { exit 0 }

New-Item -ItemType Directory -Force -Path $kwosDir | Out-Null
New-Item -ItemType File     -Force -Path $flag     | Out-Null

# Output additionalContext for Claude
# DERSELBE SATZ WIE AUF POSIX, WORTGLEICH. Die kuerzere Fassung („then call setSessionWorkitem")
# war auf Windows nicht ausfuehrbar: mit ENABLE_TOOL_SEARCH=true ist setSessionWorkitem ein
# DEFERRED MCP-Werkzeug -- ohne ToolSearch ist es nicht aufrufbar, und ohne den Verbots-Satz wich
# der Agent auf Bash aus (kwos wi …), was die Regel ausdruecklich untersagt. Ergebnis: kein
# Workitem gesetzt, Arbeit nicht gebucht.
$context = "[kraftwerkOS] Session ID: $sessionId. No workitem associated yet. Ask which kw/OS workitem the user is working on. Then use ToolSearch with query `"setSessionWorkitem`" to load the MCP tool schema, and call it with sessionId=`"$sessionId`" and their workitemId. Never use Bash or shell scripts to set the workitem — it is always a deferred MCP tool."

@{
    hookSpecificOutput = @{
        hookEventName     = 'UserPromptSubmit'
        additionalContext = $context
    }
} | ConvertTo-Json -Compress | Write-Output

exit 0
