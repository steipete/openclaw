param(
  [Parameter(Mandatory=$true)][ValidateSet('capture','restore')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$Entry,
  [Parameter(Mandatory=$true)][string]$Receipt
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'User PATH fixture is confined to the admitted disposable hosted Windows guest'
}
$current = [Environment]::GetEnvironmentVariable('Path','User')
if ($Operation -eq 'capture') {
  if (@($current -split ';' | Where-Object { $_ -ieq $Entry }).Count) { throw 'Fresh fixture path already existed in user PATH' }
  @{ before=$current; entry=$Entry } | ConvertTo-Json | Set-Content -LiteralPath $Receipt -Encoding utf8
  Write-Output '127254_USER_PATH_CAPTURED'
  exit 0
}
$old = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
if ($old.entry -cne $Entry) { throw 'User PATH receipt entry mismatch' }
$expected = if ([string]::IsNullOrWhiteSpace($old.before)) { $Entry } else { "$($old.before);$Entry" }
if ($current -cne $expected) {
  throw 'Guest user PATH changed beyond the real producer addition; preserve it and retain fixture'
}
[Environment]::SetEnvironmentVariable('Path',$old.before,'User')
if ([Environment]::GetEnvironmentVariable('Path','User') -cne $old.before) { throw 'Guest PATH restoration was not observed' }
@{ entry=$Entry; restored=$true; exactOriginal=$true } | ConvertTo-Json
