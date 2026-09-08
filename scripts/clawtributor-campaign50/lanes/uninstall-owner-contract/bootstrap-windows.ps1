param([string]$TargetDir,[string]$LaneDir,[string]$EvidenceDir,[ValidateSet('baseline')][string]$Mode)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:PROOF_LANE -ne 'uninstall-owner-windows' -or $env:PROOF_DIRECTORY -ne 'uninstall-owner-contract' -or $env:RUNNER_OS -ne 'Windows' -or $env:SOURCE_SHA -ne 'f5a30f8484671abdb422a9ea8b39837a668ed019' -or
    $env:NODE_VERSION -ne '24.20.0' -or $env:PNPM_VERSION -ne '12.3.4') {
  throw 'Expected exact reviewed secretless hosted Windows route'
}
$TargetDir=(Resolve-Path -LiteralPath $TargetDir).Path
$LaneDir=(Resolve-Path -LiteralPath $LaneDir).Path
New-Item -ItemType Directory -Force $EvidenceDir | Out-Null
$EvidenceDir=(Resolve-Path -LiteralPath $EvidenceDir).Path
$python=(Get-Command python -CommandType Application | Select-Object -First 1).Source
& $python -I -S (Join-Path $LaneDir 'verify-inputs.py') $LaneDir $TargetDir (Join-Path $EvidenceDir 'input-before.json')
if ($LASTEXITCODE -ne 0) { throw 'Frozen input gate failed' }
$head=(& git -C $TargetDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $env:SOURCE_SHA) { throw 'Wrong target commit' }
$dirty=& git -C $TargetDir status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Dirty target' }
$actualNode=(& node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or $actualNode -ne '24.20.0') { throw 'Wrong workflow Node selection' }
$proofHome=Join-Path $env:RUNNER_TEMP ('owner-127254-bootstrap-'+[guid]::NewGuid().ToString('N'))
foreach ($part in @('','tmp','AppData/Roaming','AppData/Local')) {
  New-Item -ItemType Directory -Path (Join-Path $proofHome $part) | Out-Null
}
$workerEnv=@{}
foreach ($key in @('SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','PROGRAMDATA',
    'SOURCE_SHA','NODE_VERSION','PNPM_VERSION','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','ImageOS','ImageVersion')) {
  $value=[Environment]::GetEnvironmentVariable($key)
  if ($null -ne $value) { $workerEnv[$key]=$value }
}
$workerEnv['PATH']=[Environment]::GetEnvironmentVariable('PATH')
$workerEnv['HOME']=$proofHome
$workerEnv['USERPROFILE']=$proofHome
$workerEnv['APPDATA']=Join-Path $proofHome 'AppData/Roaming'
$workerEnv['LOCALAPPDATA']=Join-Path $proofHome 'AppData/Local'
$workerEnv['TEMP']=Join-Path $proofHome 'tmp'
$workerEnv['TMP']=Join-Path $proofHome 'tmp'
$workerEnv['CI']='1'
$request=@{
  argv=@((Get-Process -Id $PID).Path,'-NoProfile','-NonInteractive','-File',(Join-Path $LaneDir 'run.ps1'),$TargetDir,$LaneDir,$EvidenceDir,$Mode)
  cwd=$proofHome
  env=$workerEnv
  evidence=$EvidenceDir
}
$requestFile=Join-Path $proofHome 'worker-request.json'
$request | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $requestFile -Encoding utf8
$code=1
try {
  & $python -I -S (Join-Path $LaneDir 'bootstrap-runner.py') $requestFile
  $code=$LASTEXITCODE
} finally {
  @{ exitCode=$code; bootstrapHome=$proofHome; retained=$true } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'bootstrap-outcome.json')
}
& $python -I -S (Join-Path $LaneDir 'verify-inputs.py') $LaneDir $TargetDir (Join-Path $EvidenceDir 'input-after.json')
if ($LASTEXITCODE -ne 0) { throw 'Post-input gate failed' }
& git -C $TargetDir diff --binary $env:SOURCE_SHA -- | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'bootstrap-final-working-tree.patch')
if ($LASTEXITCODE -ne 0 -or (& git -C $TargetDir status --porcelain)) { throw 'Target source changed' }
$code | Set-Content -Encoding ascii (Join-Path $EvidenceDir 'exit-code.txt')
if ($code -eq 0) {
  $bootstrap=Get-Content -LiteralPath (Join-Path $EvidenceDir 'bootstrap-process/processes.json') -Raw | ConvertFrom-Json
  if (-not $bootstrap.quiescent -or -not $bootstrap.allPassed) { throw 'Bootstrap worker completion missing' }
  $cleanup=Get-Content -LiteralPath (Join-Path $EvidenceDir 'cleanup.json') -Raw | ConvertFrom-Json
  $outer=Get-Content -LiteralPath (Join-Path $EvidenceDir 'driver-process/processes.json') -Raw | ConvertFrom-Json
  if (-not $cleanup.absent -or -not $cleanup.windowsPathRestored -or -not $outer.quiescent -or -not $outer.allPassed) { throw 'Normal fixture/driver closure missing' }
  Remove-Item -LiteralPath $proofHome -Recurse -Force
  if (Test-Path -LiteralPath $proofHome) { throw 'Bootstrap-owned home remains' }
  @{ exitCode=$code; reaped=$true; forced=$false; bootstrapHome=$proofHome; retained=$false; absent=$true } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'bootstrap-outcome.json')
}
exit $code
