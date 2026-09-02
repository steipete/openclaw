# Appended to the exact installer module without its canonical entrypoint, as in install-ps1.test.ts.
$case = Get-Content -LiteralPath $env:OPENCLAW_INSTALL_PROOF_CONFIG -Raw | ConvertFrom-Json
$root = $case.root
$bin = Join-Path $root 'bin'
$nodeRoot = Join-Path $root 'archive\node-fixture'
$zip = Join-Path $root 'node archive.zip'
$destination = Join-Path $root 'portable node'
$caller = Join-Path $root 'caller directory'
$argsLog = Join-Path $root 'tar-args.txt'
$cwdLog = Join-Path $root 'tar-cwd.txt'
$previousPath = $env:PATH
$previousLocation = (Get-Location).Path
$errors = New-Object System.Collections.Generic.List[string]
$caught = $null
$completed = $false
$output = @()
$nativeExit = $null
$phase = 'setup'
$record = [ordered]@{
    schema = 'openclaw-portable-node-extraction-proof-v1'
    id = $case.id
    mode = $case.mode
    outcome = $case.outcome
    engine = $PSVersionTable.PSVersion.ToString()
    edition = $PSVersionTable.PSEdition
    hostName = $Host.Name
    stdoutRedirected = [Console]::IsOutputRedirected
    stderrRedirected = [Console]::IsErrorRedirected
    nativeErrorPreference = (Get-Variable PSNativeCommandUseErrorActionPreference -ValueOnly -ErrorAction SilentlyContinue)
    nativeArgumentPassing = (Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue)
}
function Main { throw 'Unexpected installer entrypoint' }
function Invoke-WebRequest { throw 'Unexpected network request' }
function Invoke-RestMethod { throw 'Unexpected network request' }
try {
    if ($case.mode -notin @('redirected', 'unmerged') -or $case.outcome -notin @('noisy-failure', 'quiet-failure', 'tar-success')) {
        throw 'Invalid proof case'
    }
    New-Item -ItemType Directory -Force -Path $bin, $nodeRoot, $caller | Out-Null
    [IO.File]::WriteAllText((Join-Path $nodeRoot 'node.exe'), 'node fixture bytes')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory((Split-Path -Parent $nodeRoot), $zip)
    $realTar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $realTar -PathType Leaf)) { throw 'System tar.exe unavailable' }
    $record.realTar = $realTar
    $record.realTarSha256 = (Get-FileHash -LiteralPath $realTar -Algorithm SHA256).Hash.ToLowerInvariant()
    $tarScript = @(
        '@echo off',
        ('echo %~1 > "' + $argsLog + '"'),
        ('echo %~2 >> "' + $argsLog + '"'),
        ('echo %~3 >> "' + $argsLog + '"'),
        ('echo %~4 >> "' + $argsLog + '"'),
        ('echo %~5 >> "' + $argsLog + '"'),
        ('echo %~6 >> "' + $argsLog + '"'),
        ('echo %CD% > "' + $cwdLog + '"')
    )
    if ($case.outcome -eq 'tar-success') {
        $tarScript += @(('"' + $realTar + '" %*'), 'if errorlevel 1 exit /b %errorlevel%', 'echo native-tar-complete', 'exit /b 0')
    } else {
        $tarScript += @('echo partial> "%~4\partial.marker"', 'echo native-tar-complete')
        if ($case.outcome -eq 'noisy-failure') { $tarScript += 'echo tar fixture failure 1>&2' }
        $tarScript += 'exit /b 17'
    }
    [IO.File]::WriteAllLines((Join-Path $bin 'tar.cmd'), $tarScript)
    $env:PATH = "$bin;$env:PATH"
    Set-Location -LiteralPath $caller
    $ErrorActionPreference = 'Stop'
    $record.callerLocation = (Get-Location).Path
    $record.safeLocation = Get-WindowsCommandSafeDirectory
    $record.selectedTar = (Get-Command tar -ErrorAction Stop).Source
    if ($record.selectedTar -ne (Join-Path $bin 'tar.cmd')) { throw 'Fixture tar not selected' }
    $global:LASTEXITCODE = 0
    $phase = 'invoke'
    try {
        if ($case.mode -eq 'redirected') {
            $output = @(Expand-PortableNodeArchive -ZipPath $zip -DestinationPath $destination 2>&1)
        } else {
            Expand-PortableNodeArchive -ZipPath $zip -DestinationPath $destination
        }
        $nativeExit = $LASTEXITCODE
        $completed = $true
    } catch {
        $nativeExit = $LASTEXITCODE
        $caught = $_.Exception.Message
    }
    $phase = 'verify'
    $record.completed = $completed
    $record.caught = $caught
    $record.nativeExit = $nativeExit
    $record.invocationOutput = @($output | ForEach-Object { $_.ToString() })
    $record.actualArguments = @(Get-Content -LiteralPath $argsLog | ForEach-Object { $_.TrimEnd() })
    $record.expectedArguments = @('-xf', $zip, '-C', $destination, '--strip-components', '1')
    $record.nativeCwd = (Get-Content -LiteralPath $cwdLog -Raw).TrimEnd()
    $record.nodeExists = Test-Path -LiteralPath (Join-Path $destination 'node.exe')
    $record.nodeSha256 = if ($record.nodeExists) { (Get-FileHash -LiteralPath (Join-Path $destination 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    $record.partialRemains = Test-Path -LiteralPath (Join-Path $destination 'partial.marker')
    $record.fallbackTempCount = @(Get-ChildItem -LiteralPath $root -Filter 'portable-node-extract-*').Count
    $record.preferenceRestored = $ErrorActionPreference -eq 'Stop'
    $record.locationRestored = (Get-Location).Path -eq $record.callerLocation
    if (-not $completed) { $errors.Add('owner invocation failed') }
    if (($record.actualArguments -join '|') -cne ($record.expectedArguments -join '|')) { $errors.Add('native argument mismatch') }
    $expectedExit = if ($case.outcome -eq 'tar-success') { 0 } else { 17 }
    if ($nativeExit -ne $expectedExit) { $errors.Add('native exit changed') }
    if ($record.nodeSha256 -ne $case.expectedNodeSha256) { $errors.Add('published bytes mismatch') }
    if ($record.partialRemains) { $errors.Add('partial tar output remains') }
    if ($record.fallbackTempCount -ne 0) { $errors.Add('fallback temporary directory remains') }
    if (-not $record.preferenceRestored -or -not $record.locationRestored) { $errors.Add('caller state leaked') }
} catch {
    $errors.Add("$phase failure: $($_.Exception.Message)")
} finally {
    try {
        Set-Location -LiteralPath $previousLocation
        $env:PATH = $previousPath
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    } catch { $errors.Add("cleanup failure: $($_.Exception.Message)") }
    $record.cleanupComplete = -not (Test-Path -LiteralPath $root)
    $record.pathRestored = $env:PATH -ceq $previousPath
    if (-not $record.cleanupComplete -or -not $record.pathRestored) { $errors.Add('fixture cleanup incomplete') }
}
$record.errors = @($errors)
$record.status = if ($errors.Count -eq 0) { 'pass' } else { 'fail' }
[IO.File]::WriteAllText($case.recordPath, ($record | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
if ($errors.Count -gt 0) { exit 1 }
exit 0
