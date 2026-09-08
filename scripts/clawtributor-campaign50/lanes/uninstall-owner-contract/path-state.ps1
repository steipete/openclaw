param(
  [Parameter(Mandatory=$true)][ValidateSet('capture','restore')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$Entry,
  [Parameter(Mandatory=$true)][string]$Receipt,
  [Parameter(Mandatory=$true)][string]$Diagnostic
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'User PATH fixture is confined to the admitted disposable hosted Windows guest'
}
# Exact spelling produced by the pinned Install-OpenClawFromGit, including its doubled separator.
$producerEntry = Join-Path $env:USERPROFILE '.local\\bin'
if ($Entry -cne $producerEntry) {
  throw 'PATH fixture directory differs from the pinned Git producer destination'
}
$runtime = @{
  powershell=$PSVersionTable.PSVersion.ToString()
  runtimeVersion=[Environment]::Version.ToString()
  framework=[System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', ($Operation -eq 'restore'))
if ($null -eq $key) { throw 'Existing guest user Environment key is required' }
function Read-PathState {
  $present = @($key.GetValueNames()) -icontains 'Path'
  if (-not $present) { return @{ present=$false; supported=$true; kind=$null; raw=$null; expanded=$null } }
  $kind = $key.GetValueKind('Path').ToString()
  if ($kind -notin @('String','ExpandString')) {
    return @{ present=$true; supported=$false; kind=$kind; raw=$null; expanded=$null }
  }
  $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $expanded = [Environment]::GetEnvironmentVariable('Path','User')
  if ($raw -isnot [string] -or $expanded -isnot [string] -or $raw.Length -gt 32767 -or $expanded.Length -gt 32767) {
    return @{ present=$true; supported=$false; kind=$kind; raw=$null; expanded=$null }
  }
  return @{ present=$true; supported=$true; kind=$kind; raw=$raw; expanded=$expanded }
}
function Same-PathState($Left, $Right) {
  return $Left.present -eq $Right.present -and $Left.supported -eq $Right.supported -and $Left.kind -ceq $Right.kind -and
    $Left.raw -ceq $Right.raw -and $Left.expanded -ceq $Right.expanded
}
try {
  $current = Read-PathState
  if ($Operation -eq 'capture') {
    if (-not $current.supported) { throw 'Guest user PATH is not a bounded supported string value' }
    if (@($current.expanded -split ';' | Where-Object { $_ -ieq $Entry }).Count) {
      throw 'Fresh fixture path already existed in user PATH'
    }
    @{ before=$current.expanded; beforeState=$current; entry=$Entry; runtime=$runtime } |
      ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Receipt -Encoding utf8
    @{ phase='captured'; original=$current; entry=$Entry; runtime=$runtime } |
      ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Diagnostic -Encoding utf8
    Write-Output '127254_USER_PATH_CAPTURED'
    exit 0
  }
  $old = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
  if ($old.entry -cne $Entry) { throw 'User PATH receipt entry mismatch' }
  $expectedText = if ([string]::IsNullOrWhiteSpace($old.before)) { $Entry } else { "$($old.before);$Entry" }
  $expected = @{ present=$true; supported=$true; kind='String'; raw=$expectedText; expanded=$expectedText }
  $pathFacts = @{ phase='restore-check'; original=$old.beforeState; current=$current; expected=$expected; entry=$Entry; runtime=$runtime }
  $pathFacts | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Diagnostic -Encoding utf8
  if (-not (Same-PathState $current $expected)) {
    throw 'Guest user PATH differs from the exact producer append/type; preserve it and retain fixture'
  }
  if ($old.beforeState.present) {
    $key.SetValue('Path', $old.beforeState.raw, [Microsoft.Win32.RegistryValueKind]$old.beforeState.kind)
  } else {
    $key.DeleteValue('Path', $true)
  }
  $restored = Read-PathState
  $pathFacts.phase = 'restored'
  $pathFacts.restored = $restored
  $pathFacts.exactOriginal = Same-PathState $restored $old.beforeState
  $pathFacts | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Diagnostic -Encoding utf8
  if (-not $pathFacts.exactOriginal) { throw 'Original guest PATH value/type/presence restoration was not observed' }
  @{ entry=$Entry; restored=$true; exactOriginal=$true; rawValueKindAndPresenceRestored=$true } | ConvertTo-Json
} finally {
  $key.Dispose()
}
