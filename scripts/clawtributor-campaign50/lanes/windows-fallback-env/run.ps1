param(
  [Parameter(Mandatory = $true, Position = 0)][string]$TargetDir,
  [Parameter(Mandatory = $true, Position = 1)][string]$LaneDir,
  [Parameter(Mandatory = $true, Position = 2)][string]$EvidenceDir,
  [Parameter(Mandatory = $true, Position = 3)][ValidateSet("green")][string]$Mode
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
$baseline = Get-Content -Raw (Join-Path $LaneDir "expected-source.json") | ConvertFrom-Json
if ($sourceSha -ne $baseline.sourceSha -or
    (Get-FileHash -Algorithm SHA256 (Join-Path $TargetDir "src/daemon/schtasks-runtime.ts")).Hash.ToLowerInvariant() -ne $baseline.baselineSha256) {
  throw "Baseline source differs from reviewed packet"
}
function Apply-CandidatePatch([string]$patch) {
  & git apply --check (Join-Path $LaneDir $patch)
  if ($LASTEXITCODE -ne 0) { throw "Candidate patch does not apply: $patch" }
  & git apply (Join-Path $LaneDir $patch)
  if ($LASTEXITCODE -ne 0) { throw "Candidate patch application failed: $patch" }
}
function Run-Focused([string]$name, [string]$file, [string]$phase, [int]$minimum) {
  $jsonPath = Join-Path $EvidenceDir "$name.json"
  $logPath = Join-Path $EvidenceDir "$name.log"
  & node scripts/run-vitest.mjs $file --reporter=verbose --reporter=json "--outputFile=$jsonPath" *> $logPath
  $testExit = $LASTEXITCODE
  $testExit | Set-Content (Join-Path $EvidenceDir "$name-exit.txt")
  & node (Join-Path $LaneDir "validate-focused.mjs") $jsonPath $logPath $file $phase $testExit $minimum *> (Join-Path $EvidenceDir "$name-validation.log")
  if ($LASTEXITCODE -ne 0) { throw "Focused proof rejected: $name" }
}
$expectedFiles = Get-Content -Raw (Join-Path $LaneDir "expected-files.json") | ConvertFrom-Json
function Assert-CandidateFiles([switch]$BaselineRuntime) {
  foreach ($file in $expectedFiles.PSObject.Properties) {
    $expectedHash = if ($BaselineRuntime -and $file.Name -eq "src/daemon/schtasks-runtime.ts") { $baseline.baselineSha256 } else { $file.Value }
    if ((Get-FileHash -Algorithm SHA256 (Join-Path $TargetDir $file.Name)).Hash.ToLowerInvariant() -ne $expectedHash) {
      throw "Candidate source differs: $($file.Name)"
    }
  }
}
Apply-CandidatePatch "regression.patch"
Assert-CandidateFiles -BaselineRuntime
Run-Focused "native-regression-red" "src/daemon/schtasks.env-case.real.test.ts" "red" 1
Assert-CandidateFiles -BaselineRuntime
Apply-CandidatePatch "production.patch"
Assert-CandidateFiles
& node --import ./scripts/tsx.mjs (Join-Path $LaneDir "native-env-proof.mjs") $TargetDir $EvidenceDir *> (Join-Path $EvidenceDir "native-env.log")
$proofExit = $LASTEXITCODE
$proofExit | Set-Content (Join-Path $EvidenceDir "proof-process-exit.txt")
$report = Get-Content -Raw (Join-Path $EvidenceDir "native-env-results.json") | ConvertFrom-Json
$caseNames = @("case-collision", "same-case", "reverse-case", "new-key", "inherited-key", "path-excluded")
if ($proofExit -ne 0 -or $report.sourceSha -ne $sourceSha -or $report.platform -ne "win32" -or
    $report.nodeVersion -ne $env:NODE_VERSION -or $report.results.Count -ne 6 -or
    @($report.failures).Count -ne 0 -or (Compare-Object $caseNames @($report.results | ForEach-Object name))) {
  throw "Candidate native proof failed or its receipt is incomplete"
}
foreach ($result in $report.results) {
  if (-not $result.passed -or -not $result.childExited -or $result.observed.platform -ne "win32" -or
      $result.observed.value -ne $result.expected -or $result.observed.control -ne "control" -or
      $result.observed.parentOnly -ne "parent-preserved" -or $result.observed.pathHash -ne $report.parentPathHash) {
    throw "Candidate native child or sibling control failed"
  }
}
Run-Focused "native-regression-green" "src/daemon/schtasks.env-case.real.test.ts" "green" 2
Run-Focused "startup-fallback" "src/daemon/schtasks.startup-fallback.test.ts" "green" 1
Run-Focused "process-env" "src/infra/process-env.test.ts" "green" 1
Assert-CandidateFiles
& git diff --binary | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "candidate-working-tree.patch")
if ($LASTEXITCODE -ne 0) { throw "Could not retain candidate patch" }
$expectedFiles | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "candidate-files.json")
Write-Output "Six native environment cases and all three focused suites passed"
exit 0
