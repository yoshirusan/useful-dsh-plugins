#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the pinned starter kit from data/verified.json.

.DESCRIPTION
    Installs exactly the versions this repository was last verified against, not
    "latest", which may have moved. Pairs marked in plugins.json with conflictWith
    solve the same problem: only the first member of each pair is installed. Pass
    -IncludeConflicts to install every entry.

.PARAMETER DryRun
    Print the commands without running them.

.PARAMETER Only
    Only install plugins whose name matches one of these (wildcards allowed).

.PARAMETER IncludeConflicts
    Install both members of every conflicting pair.

.PARAMETER Profile
    Pass --profile <name> to every "dsh plugin add".

.EXAMPLE
    ./scripts/install.ps1 -DryRun

.EXAMPLE
    ./scripts/install.ps1 -Only 'dsh-git-*','dsh-md-studio'
#>
[CmdletBinding()]
param(
    [switch] $DryRun,
    [string[]] $Only,
    [switch] $IncludeConflicts,
    [string] $Profile
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$verifiedPath = Join-Path $repoRoot 'data/verified.json'

if (-not (Test-Path $verifiedPath)) {
    throw "data/verified.json is missing. Run 'node scripts/sync.mjs' first."
}

$verified = Get-Content $verifiedPath -Raw | ConvertFrom-Json
$picks = @($verified.plugins | Where-Object { $_.status -eq 'ok' -and $_.installTarget })

if (-not $picks.Count) {
    throw 'No installable entries in data/verified.json - re-run the sync.'
}

if ($Only) {
    $picks = @($picks | Where-Object {
        $name = $_.name
        @($Only | Where-Object { $name -like $_ }).Count -gt 0
    })
    if (-not $picks.Count) { throw "No plugin matched: $($Only -join ', ')" }
}

if (-not $DryRun -and -not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    throw @'
The "dsh" command is not on PATH.

Install from the GUI instead:
  Settings -> Plugins -> Discover, then add the index
  https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json

Or re-run with -DryRun to see the exact commands without installing.
'@
}

# Choose one member per conflicting pair: whichever appears first in data/verified.json.
$skip = @{}
if (-not $IncludeConflicts) {
    $firstOfPair = @{}
    foreach ($pick in $picks) {
        if (-not $pick.entry.conflictWith) { continue }
        $pairKey = (@($pick.name, $pick.entry.conflictWith) | Sort-Object) -join '|'
        if ($firstOfPair.ContainsKey($pairKey)) {
            $skip[$pick.name] = $firstOfPair[$pairKey]
        }
        else {
            $firstOfPair[$pairKey] = $pick.name
        }
    }
}

$installed = 0
$skipped = 0
foreach ($pick in $picks) {
    if ($skip.ContainsKey($pick.name)) {
        Write-Host ("  skip    {0}  (pairs with {1})" -f $pick.name, $skip[$pick.name]) -ForegroundColor DarkGray
        $skipped++
        continue
    }

    $cliArgs = @('plugin', 'add', $pick.installTarget)
    if ($Profile) { $cliArgs = @('plugin', '--profile', $Profile, 'add', $pick.installTarget) }

    if ($DryRun) {
        Write-Host ("  would   dsh {0}" -f ($cliArgs -join ' ')) -ForegroundColor Cyan
        continue
    }

    Write-Host ("  install {0}" -f $pick.installTarget) -ForegroundColor Green
    & dsh @cliArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "dsh plugin add $($pick.installTarget) exited with $LASTEXITCODE"
        continue
    }
    $installed++
}

if ($DryRun) {
    Write-Host ''
    Write-Host 'Dry run only - nothing was installed.'
}
else {
    Write-Host ''
    Write-Host "Installed $installed, skipped $skipped conflicting entries."
    Write-Host 'Restart DeepSeek Harness to load newly installed plugins.'
}
