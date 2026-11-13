# Installs the package from the "Build Dev package" workflow next to the Store app.
# Needs Developer Mode. The app runs from the layout folder, so don't delete it.
[CmdletBinding()]
param(
    [string]$RunId,
    [string]$Repo,
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'IntelligentTerminalDev')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$devMode = Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
if ($devMode -ne 1) { throw 'Turn on Developer Mode first.' }

if (-not $Repo) { $Repo = "$(gh api user -q .login)/intelligent-terminal" }
if (-not $RunId) {
    $RunId = gh run list -R $Repo --workflow 'Build Dev package' --status success --limit 1 --json databaseId -q '.[0].databaseId'
    if (-not $RunId) { throw "No successful build in $Repo." }
}
Write-Host "Installing run $RunId from $Repo"

$download = Join-Path $Root "download-$RunId"
$layout = Join-Path $Root "layout-$RunId"
if (Test-Path $download) { Remove-Item -Recurse -Force $download }
gh run download $RunId -R $Repo -n intelligent-terminal-dev-x64 -D $download
if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }

$msix = Get-ChildItem $download -Recurse -Filter 'CascadiaPackage*.msix' | Select-Object -First 1
if (-not $msix) { throw 'No .msix in the download.' }

# File names inside an .msix are URL-encoded, so decode them while unpacking.
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
$zip = [IO.Compression.ZipFile]::OpenRead($msix.FullName)
try {
    foreach ($entry in $zip.Entries) {
        if (-not $entry.Name) { continue }
        $target = Join-Path $layout ([Uri]::UnescapeDataString($entry.FullName) -replace '/', '\')
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
}
finally { $zip.Dispose() }

# Install the framework packages the app needs, if they're missing.
foreach ($dep in Get-ChildItem $download -Recurse -Filter '*.appx' | Where-Object { $_.DirectoryName -match '\\Dependencies\\x64' }) {
    try { Add-AppxPackage -Path $dep.FullName -ErrorAction Stop; Write-Host "Installed $($dep.Name)" }
    catch { Write-Host "Skipped $($dep.Name) (already installed)" }
}

[xml]$manifest = Get-Content (Join-Path $layout 'AppxManifest.xml')
$identity = $manifest.Package.Identity

# Replace the previous install but keep its settings.
$existing = Get-AppxPackage -Name $identity.Name | Where-Object { $_.Publisher -eq $identity.Publisher }
if ($existing) { $existing | Remove-AppxPackage -PreserveApplicationData }

Add-AppxPackage -Register (Join-Path $layout 'AppxManifest.xml') -ForceApplicationShutdown
$installed = Get-AppxPackage -Name $identity.Name | Where-Object { $_.Publisher -eq $identity.Publisher }
Write-Host "Installed $($installed.PackageFullName)"
Write-Host "Settings: $(Join-Path $env:LOCALAPPDATA "Packages\$($installed.PackageFamilyName)\LocalState\settings.json")"

Get-ChildItem $Root -Directory | Where-Object { $_.Name -like 'layout-*' -and $_.FullName -ne $layout } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $download -ErrorAction SilentlyContinue
