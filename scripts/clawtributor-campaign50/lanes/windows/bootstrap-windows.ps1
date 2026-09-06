param(
  [Parameter(Mandatory = $true, Position = 0)][string]$TargetDir,
  [Parameter(Mandatory = $true, Position = 1)][string]$LaneDir,
  [Parameter(Mandatory = $true, Position = 2)][string]$EvidenceDir,
  [Parameter(Mandatory = $true, Position = 3)][ValidateSet("red", "green")][string]$Mode,
  [switch]$Worker
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne "true" -or
    $env:RUNNER_ENVIRONMENT -ne "github-hosted" -or $env:RUNNER_OS -ne "Windows") {
  throw "This bootstrap requires the reviewed GitHub-hosted windows-2025 job"
}
if ($env:SOURCE_SHA -notmatch "^[0-9a-f]{40}$" -or
    $env:NODE_VERSION -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$" -or
    $env:PNPM_VERSION -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$") {
  throw "Missing exact reviewed source, Node, or pnpm pin"
}
$TargetDir = (Resolve-Path -LiteralPath $TargetDir).Path
$LaneDir = (Resolve-Path -LiteralPath $LaneDir).Path
New-Item -ItemType Directory -Force $EvidenceDir | Out-Null
$EvidenceDir = (Resolve-Path -LiteralPath $EvidenceDir).Path
$nodeExe = (Get-Command node.exe -CommandType Application).Source
$nodeDir = Split-Path $nodeExe
$npmCmd = Join-Path $nodeDir "npm.cmd"
if (-not (Test-Path -LiteralPath $npmCmd -PathType Leaf)) {
  throw "The selected Node installation does not contain npm.cmd"
}

if (-not $Worker) {
  $proofHome = Join-Path $env:RUNNER_TEMP ("clawtributor-windows-" + [guid]::NewGuid().ToString("N"))
  $toolsDir = Join-Path $proofHome "tools"
  $tempDir = Join-Path $proofHome "tmp"
  $roamingDir = Join-Path $proofHome "AppData/Roaming"
  $localDir = Join-Path $proofHome "AppData/Local"
  foreach ($directory in @($proofHome, $toolsDir, $tempDir, $roamingDir, $localDir)) {
    New-Item -ItemType Directory $directory | Out-Null
  }
  # Start a separate PowerShell with only explicit platform facts and reviewed pins.
  # Target installation and execution never inherit workflow authentication variables.
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = (Get-Process -Id $PID).Path
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WorkingDirectory = $proofHome
  $start.Environment.Clear()
  foreach ($name in @(
      "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES",
      "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA", "USERNAME", "USERDOMAIN",
      "SOURCE_SHA", "NODE_VERSION", "PNPM_VERSION", "ImageOS", "ImageVersion"
  )) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $start.Environment[$name] = $value }
  }
  $start.Environment["PATH"] = "$toolsDir;$nodeDir;" + [Environment]::GetEnvironmentVariable("PATH")
  $start.Environment["HOME"] = $proofHome
  $start.Environment["USERPROFILE"] = $proofHome
  $start.Environment["APPDATA"] = $roamingDir
  $start.Environment["LOCALAPPDATA"] = $localDir
  $start.Environment["TEMP"] = $tempDir
  $start.Environment["TMP"] = $tempDir
  $start.Environment["NPM_CONFIG_USERCONFIG"] = Join-Path $proofHome ".npmrc"
  $start.Environment["CI"] = "1"
  $start.Environment["GITHUB_ACTIONS"] = "true"
  $start.Environment["RUNNER_OS"] = "Windows"
  $start.Environment["RUNNER_ENVIRONMENT"] = "github-hosted"
  foreach ($argument in @("-NoProfile", "-NonInteractive", "-File", $PSCommandPath,
      $TargetDir, $LaneDir, $EvidenceDir, $Mode, "-Worker")) {
    $start.ArgumentList.Add($argument)
  }
  $child = [System.Diagnostics.Process]::new()
  $child.StartInfo = $start
  try {
    if (-not $child.Start()) { throw "Isolated Windows proof worker did not start" }
    $child.WaitForExit()
    $childExit = $child.ExitCode
  } finally {
    $child.Dispose()
  }
  exit $childExit
}

$toolsDir = Join-Path $env:USERPROFILE "tools"
$proofExit = 1
try {
  $sourceSha = (& git -C $TargetDir rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $sourceSha -ne $env:SOURCE_SHA) {
    throw "Checkout SHA differs from the reviewed source"
  }
  $dirty = & git -C $TargetDir status --porcelain
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Target checkout is not clean" }
  $package = Get-Content -Raw -LiteralPath (Join-Path $TargetDir "package.json") | ConvertFrom-Json
  if ($package.packageManager -notmatch "^pnpm@([0-9]+\.[0-9]+\.[0-9]+)(\+sha(256|512)\.[a-f0-9]+)?$" -or
      $Matches[1] -ne $env:PNPM_VERSION) {
    throw "Reviewed pnpm version differs from the source packageManager"
  }
  $actualNode = (& $nodeExe -p "process.versions.node").Trim()
  if ($LASTEXITCODE -ne 0 -or $actualNode -ne $env:NODE_VERSION) {
    throw "Selected Node version differs from the reviewed pin"
  }

  Set-Location $toolsDir
  & $npmCmd install --global --prefix $toolsDir --registry=https://registry.npmjs.org "pnpm@$env:PNPM_VERSION" *> (Join-Path $EvidenceDir "pnpm-install.log")
  if ($LASTEXITCODE -ne 0) { throw "Pinned pnpm installation failed" }
  # pnpm12 regenerates this npm shim to its installed Windows-native executable.
  $pnpmCmd = Join-Path $toolsDir "pnpm.cmd"
  $actualPnpm = (& $pnpmCmd --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualPnpm -ne $env:PNPM_VERSION) {
    throw "Installed pnpm version differs from the reviewed pin"
  }
  if ((Split-Path (Get-Command pnpm).Source) -ne $toolsDir) {
    throw "Bare pnpm does not resolve to the validated task-local installation"
  }
  @{
    source = $sourceSha
    mode = $Mode
    node = $actualNode
    pnpm = $actualPnpm
    packageManager = $package.packageManager
    platform = [Environment]::OSVersion.ToString()
    image = $env:ImageOS
    imageVersion = $env:ImageVersion
    isolation = "fresh-home-userprofile-allowlisted-process-environment"
  } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "source.json")

  Set-Location $TargetDir
  & $pnpmCmd install --frozen-lockfile *> (Join-Path $EvidenceDir "dependencies.log")
  if ($LASTEXITCODE -ne 0) { throw "Frozen source dependency installation failed" }
  & (Join-Path $LaneDir "run.ps1") $TargetDir $LaneDir $EvidenceDir $Mode
  $proofExit = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $proofExit = 1
} finally {
  $proofExit | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "exit-code.txt")
  & git -C $TargetDir diff --binary | Set-Content -Encoding utf8 (Join-Path $EvidenceDir "final-working-tree.patch")
}
exit $proofExit
