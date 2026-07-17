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

$kwosDir = Join-Path $env:USERPROFILE '.kwos'
$flag    = Join-Path $kwosDir "injected-$sessionId"

# Already injected this session — exit immediately
if (Test-Path $flag) { exit 0 }

New-Item -ItemType Directory -Force -Path $kwosDir | Out-Null
New-Item -ItemType File     -Force -Path $flag     | Out-Null

# Output additionalContext for Claude
$context = "[kraftwerkOS] Session ID: $sessionId. No workitem associated yet. Ask which kw/OS workitem the user is working on, then call setSessionWorkitem with sessionId=`"$sessionId`" and their answer."

@{
    hookSpecificOutput = @{
        hookEventName     = 'UserPromptSubmit'
        additionalContext = $context
    }
} | ConvertTo-Json -Compress | Write-Output

exit 0
