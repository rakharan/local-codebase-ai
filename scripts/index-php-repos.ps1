$ErrorActionPreference = "Continue"
$logFile = "C:\GIT\personal\local-codebase-ai\scripts\index-php-repos.log"

function Log($msg) {
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "$ts $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

Set-Location "C:\GIT\personal\local-codebase-ai"

$excludes = @(
    'src/index-repo.ts',
    '--replace-repo', '--service-type', 'library', '--index-comments',
    '--exclude', 'templates/**', '--exclude', 'css/**', '--exclude', 'images/**',
    '--exclude', 'avatar/**', '--exclude', 'php/**', '--exclude', 'nginx/**',
    '--exclude', 'docker/**', '--exclude', '**/views/**', '--exclude', '**/assets/**',
    '--exclude', 'libraries/**', '--exclude', 'plugins/**', '--exclude', 'review/**'
)

$repos = @("ims-mrg", "ims-tf", "ims-askap")

foreach ($repo in $repos) {
    $repoPath = "C:\GIT\work\$repo"
    $maxRetries = 5
    $attempt = 0
    $success = $false

    while (-not $success -and $attempt -lt $maxRetries) {
        $attempt++
        Log "=== Starting $repo (attempt $attempt) ==="

        $args = @($repoPath) + $excludes[1..($excludes.Length-1)]
        $allArgs = @($excludes[0]) + $args

        npx tsx @allArgs 2>&1 | Tee-Object -FilePath $logFile -Append

        if ($LASTEXITCODE -eq 0) {
            Log "=== Done $repo ==="
            $success = $true
        } else {
            Log "ERROR: $repo failed with exit code $LASTEXITCODE"
            if ($attempt -lt $maxRetries) {
                Log "Retrying in 5 seconds..."
                Start-Sleep -Seconds 5
            }
        }
    }

    if (-not $success) {
        Log "GIVING UP on $repo after $maxRetries attempts"
    }
}

Log "ALL PHP REPOS DONE"
