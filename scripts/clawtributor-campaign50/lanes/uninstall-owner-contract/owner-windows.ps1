param(
  [Parameter(Mandatory=$true)][string]$LaneDir,
  [Parameter(Mandatory=$true)][string]$RepoDir,
  [Parameter(Mandatory=$true)][string]$SourceSha
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows -or $SourceSha -ne 'f5a30f8484671abdb422a9ea8b39837a668ed019' -or
    $env:CI -ne '1' -or $env:NPM_CONFIG_OFFLINE -ne 'true') {
  throw 'Wrong isolated native Windows owner boundary'
}
Set-Location -LiteralPath $RepoDir
# The complete script's actual dry-run returns after definitions/temporary-directory setup.
. (Join-Path $LaneDir 'source/install.ps1') -InstallMethod git -GitDir $RepoDir -NoOnboard -NoGitUpdate -DryRun
$result = @(Install-OpenClawFromGit -RepoDir $RepoDir -SkipUpdate)
if (-not (Test-BooleanSuccessResult -Results $result)) { throw 'Real Git owner failed' }
