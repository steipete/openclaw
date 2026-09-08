param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
if (-not $IsWindows -or $request.command -notmatch '\.cmd$') { throw 'Expected a native Windows cmd launcher' }
$arguments = @($request.arguments | ForEach-Object { [string]$_ })
& $request.command @arguments
exit $LASTEXITCODE
