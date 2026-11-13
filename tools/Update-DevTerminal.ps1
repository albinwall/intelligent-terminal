# Installs a Dev build into a running Dev Intelligent Terminal: closes its window so it
# saves the layout, installs, starts it again, and can tell a restored Claude session to
# carry on. The install ends every session in the Dev Terminal, so start this outside it,
# detached, for example from a Claude session in it:
#   Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine =
#     'powershell.exe -NoProfile -WindowStyle Hidden -File <this> -Log <file> ...' }
# and only once the owner said go.
[CmdletBinding()]
param(
    [string]$RunId,
    [string]$ResumeSession,
    [string]$Message,
    [Parameter(Mandatory)][string]$Log
)

function Log($text) { "$(Get-Date -Format 'HH:mm:ss') $text" | Add-Content -LiteralPath $Log }

$family = 'IntelligentTerminal_rd9vj3e6a2mbr'
$wtcli = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\$family\wtcli.exe"
Log "update to run $(if ($RunId) { $RunId } else { 'latest' })"

# The process keeps running without windows after its last window closes, so wait for the
# window to go (it saves the layout then), and stop if one stays or comes back: someone is
# using it. A process with no window holds nothing to lose; the install ends it.
$terminals = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*IntelligentTerminalDev*' })
foreach ($t in $terminals) { [void]$t.CloseMainWindow() }
function OpenWindows { @($terminals | Where-Object { -not $_.HasExited } | ForEach-Object { $_.Refresh(); $_ } | Where-Object { $_.MainWindowHandle -ne 0 }) }
for ($i = 0; $i -lt 20 -and (OpenWindows); $i++) { Start-Sleep -Seconds 1 }
if (OpenWindows) { Log 'the terminal window did not close, so nothing was installed'; exit 1 }
Start-Sleep -Seconds 5
if (OpenWindows) { Log 'a terminal window is open again, so nothing was installed'; exit 1 }
Log 'the terminal window closed'

$started = Get-Date
try {
    $install = @{}
    if ($RunId) { $install.RunId = $RunId }
    & (Join-Path $PSScriptRoot 'Install-DevPackage.ps1') @install *>&1 | ForEach-Object { Log "install: $_" }
}
catch {
    Log "install failed: $_"
}
Start-Process "shell:AppsFolder\$family!App"
Log 'started the terminal'
if (-not $ResumeSession -or -not $Message) { exit 0 }

# Restored panes get new ids; the terminal's log says which pane holds the session.
$logs = Join-Path $env:LOCALAPPDATA "Packages\$family\LocalCache\Local\IntelligentTerminal\logs"
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 5
    $paneLog = Get-ChildItem $logs -Recurse -Filter 'terminal-agent-pane.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $pane = $null
    foreach ($line in Get-Content $paneLog.FullName -Tail 400) {
        if ($line -match "^\[(\S+)\] OnPaneAgentSessionChanged: bound pane (\S+) to session $ResumeSession" -and ([datetime]$Matches[1]).ToLocalTime() -gt $started) { $pane = $Matches[2] }
    }
    if (-not $pane) { continue }
    $screen = (& $wtcli --json capture-pane -t $pane -l 8 2>$null | ConvertFrom-Json).content
    if ($screen -and $screen.Contains([string][char]0x276F)) {
        Start-Sleep -Seconds 3
        & $wtcli send-keys -t $pane --raw -- $Message | Out-Null
        & $wtcli send-keys -t $pane Enter | Out-Null
        Log "told session $ResumeSession in pane $pane to carry on"
        exit 0
    }
}
Log "session $ResumeSession never came back with its prompt"
