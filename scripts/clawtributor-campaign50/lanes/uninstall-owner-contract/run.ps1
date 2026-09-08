param([string]$TargetDir,[string]$LaneDir,[string]$EvidenceDir,[ValidateSet('baseline')][string]$Mode)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$python=(Get-Command python -CommandType Application).Source
& $python -I -S (Join-Path $LaneDir 'verify-inputs.py') $LaneDir $TargetDir (Join-Path $EvidenceDir 'runner-input-before.json')
if ($LASTEXITCODE -ne 0) { throw 'Input gate failed' }
& $python -I -S (Join-Path $LaneDir 'supervisor-controls.py') check (Join-Path $EvidenceDir 'supervisor-controls')
if ($LASTEXITCODE -ne 0) { throw 'Inert supervisor controls failed before target execution' }
& $python -I -S (Join-Path $LaneDir 'launch-driver.py') $TargetDir $EvidenceDir windows
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $python -I -S (Join-Path $LaneDir 'check-artifact.py') $EvidenceDir windows | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'acceptance.json')
exit $LASTEXITCODE
