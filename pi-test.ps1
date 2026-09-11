$ErrorActionPreference = "Stop"
$forwardArgs = New-Object System.Collections.Generic.List[string]
foreach ($arg in $args) {
    if ($arg -eq "--no-env") {
        Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
    } else {
        $forwardArgs.Add($arg)
    }
}
$tsxBin = Join-Path $PSScriptRoot "node_modules/.bin/tsx.cmd"
if (-not (Test-Path -LiteralPath $tsxBin)) {
    throw "tsx is missing. Run npm ci --ignore-scripts in the repository first."
}
$cliPath = Join-Path $PSScriptRoot "packages/coding-agent/src/cli.ts"
$tsconfigPath = Join-Path $PSScriptRoot "tsconfig.json"
& $tsxBin --tsconfig $tsconfigPath $cliPath @forwardArgs
exit $LASTEXITCODE
