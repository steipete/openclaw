param(
  [Parameter(Mandatory = $true, Position = 0)][string]$TargetDir,
  [Parameter(Mandatory = $true, Position = 1)][string]$LaneDir,
  [Parameter(Mandatory = $true, Position = 2)][string]$EvidenceDir,
  [Parameter(Mandatory = $true, Position = 3)][ValidateSet("green")][string]$Mode
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
Set-Location $TargetDir
New-Item -ItemType Directory -Force $EvidenceDir | Out-Null
$sourceSha = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceSha -ne $env:SOURCE_SHA) {
  throw "Diagnostic source checkout differs from reviewed SHA"
}
foreach ($patchName in @("regression.patch", "production.patch", "diagnostic.patch")) {
  $patchPath = Join-Path $LaneDir $patchName
  & git apply --check $patchPath
  if ($LASTEXITCODE -ne 0) { throw "Diagnostic patch does not apply: $patchName" }
  & git apply $patchPath
  if ($LASTEXITCODE -ne 0) { throw "Diagnostic patch application failed: $patchName" }
}
$env:CI_WINDOWS_SCHTASKS_HEAD = $sourceSha
$env:CI_WINDOWS_SCHTASKS_PROOF_PATH = Join-Path $EvidenceDir "scheduled-task-proof.json"
& pnpm test:windows:schtasks:integration *> (Join-Path $EvidenceDir "scheduled-task-diagnostic.log")
$testExit = $LASTEXITCODE
$testExit | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "scheduler-test-exit.txt")
& git diff --binary | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "diagnostic-working-tree.patch")
Write-Output "Scheduler diagnostic completed with test exit $testExit; inspect scheduled-task-diagnostic.log"
exit $testExit
