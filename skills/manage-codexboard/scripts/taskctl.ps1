# Windows wrapper. No global Node, runtime token reads, or working-directory changes.
$ErrorActionPreference = 'Stop'
$boardArguments = @($args)
function Fail-Board([string] $message) {
    [Console]::Error.WriteLine("CodexBoard: " + $message)
    exit 2
}
function Has-BoardCli([string] $directory) {
    return (Test-Path -LiteralPath (Join-Path $directory 'runtime\bin\node.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $directory 'runtime\packages\taskctl\dist\cli.js') -PathType Leaf)
}
function Quote-BoardArgument([string] $value) {
    # CommandLineToArgvW / C-runtime quoting preserves empty strings and quotes.
    $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
try {
    $boardApp = $null
    if (Test-Path Env:CODEXBOARD_APP_PATH) {
        if ([string]::IsNullOrWhiteSpace($env:CODEXBOARD_APP_PATH)) { Fail-Board 'CODEXBOARD_APP_PATH is empty.' }
        $boardApp = $env:CODEXBOARD_APP_PATH
        if (-not [IO.Path]::IsPathRooted($boardApp) -or -not (Has-BoardCli $boardApp)) {
            Fail-Board 'CODEXBOARD_APP_PATH must name an absolute, complete Windows installation.'
        }
    } else {
        # tauri.windows.conf.json: currentUser + productName CodexBoard Windows Test.
        foreach ($base in @($env:LOCALAPPDATA, $env:ProgramW6432, $env:ProgramFiles)) {
            if ([string]::IsNullOrWhiteSpace($base)) { continue }
            $candidate = Join-Path $base 'CodexBoard Windows Test'
            if (Has-BoardCli $candidate) { $boardApp = $candidate; break }
        }
        if (-not $boardApp) { Fail-Board 'Windows installation not found. Set CODEXBOARD_APP_PATH for a custom install directory.' }
    }
    if (Test-Path Env:CODEXBOARD_DATA_DIR) {
        if ([string]::IsNullOrWhiteSpace($env:CODEXBOARD_DATA_DIR)) { Fail-Board 'CODEXBOARD_DATA_DIR is empty.' }
    } else {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Fail-Board 'LOCALAPPDATA is missing. Set CODEXBOARD_DATA_DIR explicitly.' }
        $env:CODEXBOARD_DATA_DIR = Join-Path $env:LOCALAPPDATA 'CodexBoard\data'
    }
    $node = Join-Path $boardApp 'runtime\bin\node.exe'
    $cli = Join-Path $boardApp 'runtime\packages\taskctl\dist\cli.js'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $node
    $start.UseShellExecute = $false
    $start.WorkingDirectory = (Get-Location).ProviderPath
    $nativeArguments = @((Quote-BoardArgument $cli))
    foreach ($argument in $boardArguments) { $nativeArguments += Quote-BoardArgument ([string]$argument) }
    $start.Arguments = $nativeArguments -join ' '
    $process = [Diagnostics.Process]::Start($start)
    $process.WaitForExit()
    exit $process.ExitCode
} catch {
    Fail-Board 'Unable to run the bundled Windows CLI. Check the installation and permissions.'
}
