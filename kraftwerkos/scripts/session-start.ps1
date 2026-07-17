# session-start.ps1 — Claude Code SessionStart hook (Windows)
#
# Two local setup tasks:
#   1. CLAUDE.md injection — ensures ~/.claude/CLAUDE.md has the workitem-tracking
#      instruction so Claude asks for a workitem at session start.
#   2. Script delivery — copies hook scripts to ~\.kwos\ so the managed-settings
#      Stop and UserPromptSubmit hooks always have up-to-date scripts.

$ErrorActionPreference = 'SilentlyContinue'

$marker    = '<!-- kraftwerkOS -->'
$claudeMd  = Join-Path $env:USERPROFILE '.claude\CLAUDE.md'
$kwosDir   = Join-Path $env:USERPROFILE '.kwos'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$instruction = "$marker`n## kw/OS Workitem Tracking`nAt the start of each session, ask the user ""Which kw/OS workitem are you working on?"" then call ``setSessionWorkitem`` with their workitem ID. Only ask once per session.`n$marker"

# ── Fast path ────────────────────────────────────────────────────────────────

$markerCount = 0
if (Test-Path $claudeMd) {
    $markerCount = (Select-String -Path $claudeMd -SimpleMatch $marker -AllMatches).Matches.Count
}

$scriptsPresent = (Test-Path (Join-Path $kwosDir 'langfuse-hook.sh'))      -and
                  (Test-Path (Join-Path $kwosDir 'langfuse-hook.ps1'))     -and
                  (Test-Path (Join-Path $kwosDir 'inject-session-id.sh'))  -and
                  (Test-Path (Join-Path $kwosDir 'inject-session-id.ps1'))

if ($markerCount -eq 2 -and $scriptsPresent) { exit 0 }

# ── 1. CLAUDE.md injection ───────────────────────────────────────────────────

try {
    New-Item -ItemType Directory -Force -Path (Split-Path $claudeMd) | Out-Null

    if (Test-Path $claudeMd) {
        $original = Get-Content -Path $claudeMd -Raw -Encoding UTF8
        # Remove all existing marker blocks (handles duplicates from past bug).
        # [regex]::Escape is used so no user content can be misinterpreted as a
        # pattern — the replacement is safe without a shrinkage guard.
        $escaped  = [regex]::Escape($marker)
        $cleaned  = $original -replace "(?ms)$escaped.*?$escaped`r?`n?", ''
        $newContent = $cleaned.TrimEnd() + "`n`n" + $instruction + "`n"
    } else {
        $newContent = $instruction + "`n"
    }

    [System.IO.File]::WriteAllText($claudeMd, $newContent, [System.Text.Encoding]::UTF8)
} catch { }

# ── 2. Copy hook scripts to ~\.kwos\ ────────────────────────────────────────

try {
    New-Item -ItemType Directory -Force -Path $kwosDir | Out-Null
    Copy-Item -Force -Path (Join-Path $scriptDir 'langfuse-hook.sh')       -Destination $kwosDir
    Copy-Item -Force -Path (Join-Path $scriptDir 'langfuse-hook.ps1')      -Destination $kwosDir
    Copy-Item -Force -Path (Join-Path $scriptDir 'inject-session-id.sh')   -Destination $kwosDir
    Copy-Item -Force -Path (Join-Path $scriptDir 'inject-session-id.ps1')  -Destination $kwosDir
} catch { }

exit 0
