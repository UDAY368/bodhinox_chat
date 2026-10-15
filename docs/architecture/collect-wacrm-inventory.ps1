param(
    [string]$ReferenceRoot = '.reference/wacrm',
    [string]$OutputRoot = 'docs/architecture/wacrm-inventory'
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $ReferenceRoot).Path
$tracked = @(git -C $resolvedRoot ls-files)
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate reference repository.' }
$commit = git -C $resolvedRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot determine reference commit.' }
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

$files = @()
$routes = @()
$tables = @()
$functions = @()
$supabaseDependencies = @()
foreach ($relativePath in $tracked) {
    $absolutePath = Join-Path $resolvedRoot $relativePath
    $extension = [System.IO.Path]::GetExtension($relativePath)
    $isText = $extension -in @('.ts', '.tsx', '.sql', '.json', '.md', '.yml', '.yaml', '.toml', '.mjs', '.svg') -or
        $relativePath -match '(^|/)(Dockerfile|LICENSE|\.[^/]+)$'
    $content = if ($isText) { [System.IO.File]::ReadAllText($absolutePath) } else { $null }
    $lineCount = if ($null -ne $content) { ($content -split "`n").Count } else { $null }
    $hasSupabase = $null -ne $content -and $content -match '(?i)supabase'
    $files += [pscustomobject]@{
        path = $relativePath
        bytes = (Get-Item -LiteralPath $absolutePath).Length
        lines = $lineCount
        sha256 = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
        textScanned = $isText
        mentionsSupabase = $hasSupabase
        testFile = $relativePath -match '\.test\.(ts|tsx)$'
    }
    if ($relativePath -match '^src/.*\.(ts|tsx)$' -and $hasSupabase) {
        $supabaseDependencies += [pscustomobject]@{
            path = $relativePath
            databaseQueries = [regex]::Matches($content, '\.from\s*\(').Count
            rpcCalls = [regex]::Matches($content, '\.rpc\s*\(').Count
            authCalls = [regex]::Matches($content, '\.auth\.').Count
            storageCalls = [regex]::Matches($content, '\.storage\.').Count
            realtimeChannels = [regex]::Matches($content, '\.channel\s*\(').Count
        }
    }
    if ($relativePath -match '^src/app/(.+)/route\.ts$') {
        $route = '/' + ($Matches[1] -replace '\([^/]+\)/', '')
        $methods = @([regex]::Matches($content, 'export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b') | ForEach-Object { $_.Groups[1].Value })
        $routes += [pscustomobject]@{ path = $route; methods = ($methods -join ','); source = $relativePath }
    }
    if ($relativePath -match '^supabase/migrations/.+\.sql$') {
        foreach ($match in [regex]::Matches($content, '(?i)CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_]+)')) {
            $tables += [pscustomobject]@{ table = $match.Groups[1].Value; source = $relativePath }
        }
        foreach ($match in [regex]::Matches($content, '(?i)CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?([a-z_]+)')) {
            $functions += [pscustomobject]@{ function = $match.Groups[1].Value; source = $relativePath }
        }
    }
}

$files | Export-Csv -LiteralPath (Join-Path $OutputRoot 'files.csv') -NoTypeInformation -Encoding utf8
$routes | Export-Csv -LiteralPath (Join-Path $OutputRoot 'routes.csv') -NoTypeInformation -Encoding utf8
$tables | Export-Csv -LiteralPath (Join-Path $OutputRoot 'tables.csv') -NoTypeInformation -Encoding utf8
$functions | Export-Csv -LiteralPath (Join-Path $OutputRoot 'sql-functions.csv') -NoTypeInformation -Encoding utf8
$supabaseDependencies | Export-Csv -LiteralPath (Join-Path $OutputRoot 'supabase-dependencies.csv') -NoTypeInformation -Encoding utf8
$summary = [pscustomobject]@{
    repository = 'https://github.com/ArnasDon/wacrm'
    commit = $commit
    trackedFiles = $files.Count
    textFilesScanned = @($files | Where-Object textScanned).Count
    sourceFiles = @($files | Where-Object { $_.path -match '^src/.*\.(ts|tsx)$' }).Count
    sourceLines = ($files | Where-Object { $_.path -match '^src/.*\.(ts|tsx)$' } | Measure-Object -Property lines -Sum).Sum
    routeHandlers = $routes.Count
    pageFiles = @($files | Where-Object { $_.path -match '/page\.tsx$' }).Count
    testFiles = @($files | Where-Object testFile).Count
    sqlMigrations = @($files | Where-Object { $_.path -match '^supabase/migrations/' }).Count
    applicationTables = @($tables.table | Sort-Object -Unique).Count
    sqlFunctions = @($functions.function | Sort-Object -Unique).Count
    supabaseSourceFiles = $supabaseDependencies.Count
    reviewMethod = 'All tracked files inventoried and hashed; text scanned structurally; selected critical modules reviewed manually. No runtime or exhaustive line-by-line security audit.'
}
$summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputRoot 'summary.json') -Encoding utf8
$summary | ConvertTo-Json
