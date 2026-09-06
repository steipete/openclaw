param(
  [Parameter(Mandatory = $true, Position = 0)][string]$TargetDir,
  [Parameter(Mandatory = $true, Position = 1)][string]$LaneDir,
  [Parameter(Mandatory = $true, Position = 2)][string]$EvidenceDir,
  [Parameter(Mandatory = $true, Position = 3)][ValidateSet("red", "green")][string]$Mode
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
Set-Location $TargetDir
$packet = Get-Content -Raw (Join-Path $LaneDir "MANIFEST.json") | ConvertFrom-Json
foreach ($file in $packet.PSObject.Properties) {
  if ((Get-FileHash -Algorithm SHA256 (Join-Path $LaneDir $file.Name)).Hash.ToLowerInvariant() -ne $file.Value) {
    throw "Proof packet file differs: $($file.Name)"
  }
}
$sourceSha = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceSha -ne $env:SOURCE_SHA) { throw "Unexpected proof source" }
$expected = Get-Content -Raw (Join-Path $LaneDir "expected-source.json") | ConvertFrom-Json
if ($sourceSha -ne $expected.sourceSha) { throw "Packet source pin differs" }
$runtimePath = Join-Path $TargetDir "src/daemon/schtasks-runtime.ts"
if ((Get-FileHash -Algorithm SHA256 $runtimePath).Hash.ToLowerInvariant() -ne $expected.baselineSha256) {
  throw "Baseline runtime source differs from reviewed packet"
}
if ($Mode -eq "green") {
  if (-not $expected.candidateSha256) { throw "No reviewed green source is available" }
  & git apply --check (Join-Path $LaneDir "production.patch")
  if ($LASTEXITCODE -ne 0) { throw "Production patch does not apply" }
  & git apply (Join-Path $LaneDir "production.patch")
  if ($LASTEXITCODE -ne 0) { throw "Production patch application failed" }
}
$expectedHash = if ($Mode -eq "red") { $expected.baselineSha256 } else { $expected.candidateSha256 }
if ((Get-FileHash -Algorithm SHA256 $runtimePath).Hash.ToLowerInvariant() -ne $expectedHash) {
  throw "Runtime source differs before proof"
}
& node --import ./scripts/tsx.mjs (Join-Path $LaneDir "native-env-proof.mjs") $TargetDir $EvidenceDir *> (Join-Path $EvidenceDir "native-env.log")
$proofExit = $LASTEXITCODE
$proofExit | Set-Content (Join-Path $EvidenceDir "proof-process-exit.txt")
if ((Get-FileHash -Algorithm SHA256 $runtimePath).Hash.ToLowerInvariant() -ne $expectedHash) {
  throw "Runtime source changed during proof"
}
$report = Get-Content -Raw (Join-Path $EvidenceDir "native-env-results.json") | ConvertFrom-Json
if ($report.sourceSha -ne $sourceSha -or $report.platform -ne "win32" -or
    $report.nodeVersion -ne $env:NODE_VERSION -or $report.results.Count -ne 6) {
  throw "Native proof receipt is incomplete or mismatched"
}
$caseNames = @("case-collision", "same-case", "reverse-case", "new-key", "inherited-key", "path-excluded")
if (Compare-Object $caseNames @($report.results | ForEach-Object name)) {
  throw "Native case identities differ from the reviewed packet"
}
foreach ($result in $report.results) {
  if (-not $result.childExited -or $result.observed.platform -ne "win32") {
    throw "Native child completion is unproved"
  }
  if ($result.observed.control -ne "control" -or $result.observed.parentOnly -ne "parent-preserved" -or
      $result.observed.pathHash -ne $report.parentPathHash) {
    throw "Native sibling environment controls failed"
  }
}
if ($Mode -eq "red") {
  $failed = @($report.failures)
  $collision = @($report.results | Where-Object name -eq "case-collision")
  if ($proofExit -ne 1 -or $failed.Count -ne 1 -or $failed[0] -ne "case-collision" -or
      $collision.Count -ne 1 -or $collision[0].observed.value -ne "inherited" -or
      $collision[0].expected -ne "configured") {
    throw "Baseline did not reproduce only the expected environment override loss"
  }
  $failure = Get-Content -Raw (Join-Path $EvidenceDir "native-env-error.json") | ConvertFrom-Json
  if ($failure.code -ne "ERR_ASSERTION" -or $failure.message -notmatch "PR122658_ENV_OVERRIDE_LOST") {
    throw "Baseline failed outside the intended assertion"
  }
  Write-Output "Accepted native Windows baseline: only configured case-collision override was lost"
} elseif ($proofExit -ne 0 -or @($report.failures).Count -ne 0 -or
    @($report.results | Where-Object passed -ne $true).Count -ne 0) {
  throw "Candidate native environment proof failed"
}
exit 0
