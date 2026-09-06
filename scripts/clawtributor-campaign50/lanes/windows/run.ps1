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
  throw "Source checkout does not match the reviewed SHA"
}
$sourceSha | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "source-sha.txt")
foreach ($patchName in @("regression.patch", "production.patch")) {
  $patchPath = Join-Path $LaneDir $patchName
  & git apply --check $patchPath
  if ($LASTEXITCODE -ne 0) { throw "Reviewed patch does not apply: $patchName" }
  & git apply $patchPath
  if ($LASTEXITCODE -ne 0) { throw "Reviewed patch application failed: $patchName" }
}
$expectedFiles = Get-Content -Raw (Join-Path $LaneDir "expected-files.json") | ConvertFrom-Json -AsHashtable
$verifiedFiles = [ordered]@{}
foreach ($relativePath in ($expectedFiles.Keys | Sort-Object)) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $TargetDir $relativePath) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $expectedFiles[$relativePath].sha256) {
    throw "Candidate source bytes differ from reviewed file: $relativePath"
  }
  $verifiedFiles[$relativePath] = $hash
}
$verifiedFiles | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "candidate-files.json")

$testFile = "src/process/supervisor/supervisor.anchored-shell.real.test.ts"
$reportFile = Join-Path $EvidenceDir "anchored-shell.json"
& node scripts/run-vitest.mjs $testFile --reporter=json "--outputFile=$reportFile" *> (Join-Path $EvidenceDir "anchored-shell.log")
$testExit = $LASTEXITCODE
if (-not (Test-Path $reportFile)) { throw "Vitest emitted no structured proof" }
$report = Get-Content -Raw $reportFile | ConvertFrom-Json
$cases = @($report.testResults | ForEach-Object { $_.assertionResults })
$failures = @($cases | Where-Object { $_.status -eq "failed" })
$passed = @($cases | Where-Object { $_.status -eq "passed" })
$consoleCase = @($cases | Where-Object { $_.fullName -like "*keeps anchored Windows commands console-free*" })
if ($testExit -ne 0 -or $failures.Count -ne 0 -or $passed.Count -lt 9 -or
    $consoleCase.Count -ne 1 -or $consoleCase[0].status -ne "passed") {
  throw "Candidate must pass the console regression and all native anchored-shell controls"
}

$env:CI_WINDOWS_SCHTASKS_HEAD = $sourceSha
$env:CI_WINDOWS_SCHTASKS_PROOF_PATH = Join-Path $EvidenceDir "scheduled-task-proof.json"
& pnpm test:windows:schtasks:integration *> (Join-Path $EvidenceDir "scheduled-task.log")
if ($LASTEXITCODE -ne 0) { throw "Actual Windows Scheduled Task integration failed" }
if (-not (Test-Path $env:CI_WINDOWS_SCHTASKS_PROOF_PATH)) {
  throw "Scheduled Task integration did not produce its native proof receipt"
}
$taskProof = Get-Content -Raw $env:CI_WINDOWS_SCHTASKS_PROOF_PATH | ConvertFrom-Json
$consoleProbes = @($taskProof.consoleProbes)
if ($taskProof.result -ne "pass" -or $taskProof.head -ne $sourceSha -or
    $consoleProbes.Count -ne 3 -or
    @($consoleProbes | Where-Object { $_.hasConsole -ne $false }).Count -ne 0) {
  throw "Scheduled Task receipt lacks the three console-free native starts"
}
foreach ($relativePath in $verifiedFiles.Keys) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $TargetDir $relativePath) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $verifiedFiles[$relativePath]) { throw "Source changed during proof: $relativePath" }
}
Write-Output "PR138751_GREEN_CONFIRMED: console-free native commands preserve output, exit, descendants, and Scheduled Task lifecycle"
& git diff --check
if ($LASTEXITCODE -ne 0) { throw "Candidate patch has whitespace errors" }
& git diff --numstat | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "numstat.txt")
& git diff --binary | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "candidate.patch")
