# Local Codebase AI - Qdrant Backup & Restore Script
# Usage:
#   Backup:  .\backup-qdrant.ps1 backup
#   Restore: .\backup-qdrant.ps1 restore

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("backup", "restore")]
    [string]$Action,

    [string]$CollectionName = "code_chunks",
    [string]$QdrantUrl = "http://localhost:6333",
    [string]$BackupDir = "./backups",
    [string]$DataDir = "./.data"
)

$ErrorActionPreference = "Stop"

function Ensure-Dir([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Test-QdrantHealth([string]$Url) {
    try {
        $response = Invoke-RestMethod -Uri "$Url/healthz" -Method GET -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

function Get-LatestSnapshot([string]$Url, [string]$Collection) {
    $response = Invoke-RestMethod -Uri "$Url/collections/$Collection/snapshots" -Method GET
    $snapshots = $response.result

    if (-not $snapshots -or $snapshots.Count -eq 0) {
        return $null
    }

    # Sort by creation time descending
    $latest = $snapshots | Sort-Object { $_.creation_time } -Descending | Select-Object -First 1
    return $latest
}

function Backup-Qdrant {
    Write-Host "=== Qdrant Backup ===" -ForegroundColor Cyan

    # Check Qdrant health
    Write-Host "Checking Qdrant health at $QdrantUrl..." -NoNewline
    if (-not (Test-QdrantHealth $QdrantUrl)) {
        Write-Host " FAILED" -ForegroundColor Red
        throw "Qdrant is not reachable at $QdrantUrl. Start it first: docker compose up -d qdrant"
    }
    Write-Host " OK" -ForegroundColor Green

    # Prepare backup directory
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupPath = Join-Path $BackupDir $timestamp
    Ensure-Dir $backupPath

    # 1. Create snapshot
    Write-Host "Creating snapshot for collection '$CollectionName'..." -NoNewline
    $createResponse = Invoke-RestMethod `
        -Uri "$QdrantUrl/collections/$CollectionName/snapshots" `
        -Method POST
    Write-Host " OK" -ForegroundColor Green

    # Wait for snapshot to be ready
    Write-Host "Waiting for snapshot to be ready..." -NoNewline
    Start-Sleep -Seconds 2

    # 2. Get snapshot info
    $snapshot = Get-LatestSnapshot $QdrantUrl $CollectionName
    if (-not $snapshot) {
        throw "Failed to get snapshot info"
    }
    Write-Host " Found: $($snapshot.name)" -ForegroundColor Green

    # 3. Download snapshot
    $snapshotUrl = "$QdrantUrl/collections/$CollectionName/snapshots/$($snapshot.name)"
    $snapshotFile = Join-Path $backupPath "$CollectionName.snapshot"

    Write-Host "Downloading snapshot to $snapshotFile..." -NoNewline
    Invoke-RestMethod -Uri $snapshotUrl -Method GET -OutFile $snapshotFile
    Write-Host " OK" -ForegroundColor Green

    # 4. Backup .data directory (relationships.jsonl)
    $dataBackupFile = Join-Path $backupPath "data-backup.zip"
    if (Test-Path -LiteralPath $DataDir) {
        Write-Host "Backing up $DataDir..." -NoNewline
        Compress-Archive -Path "$DataDir\*" -DestinationPath $dataBackupFile -Force
        Write-Host " OK" -ForegroundColor Green
    } else {
        Write-Host "WARNING: $DataDir not found, skipping data backup" -ForegroundColor Yellow
    }

    # 5. Save metadata
    $metadata = @{
        timestamp         = $timestamp
        collection        = $CollectionName
        qdrant_url        = $QdrantUrl
        snapshot_name     = $snapshot.name
        snapshot_size     = (Get-Item $snapshotFile).Length
        snapshot_file     = "$CollectionName.snapshot"
        data_backup       = "data-backup.zip"
        description       = "Local Codebase AI backup"
    } | ConvertTo-Json -Depth 3

    $metadataFile = Join-Path $backupPath "metadata.json"
    $metadata | Out-File -FilePath $metadataFile -Encoding UTF8

    Write-Host ""
    Write-Host "Backup completed successfully!" -ForegroundColor Green
    Write-Host "Location: $backupPath" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "To restore on another machine:"
    Write-Host "  1. Copy this folder to the new machine"
    Write-Host "  2. Run: .\backup-qdrant.ps1 restore -BackupDir '$backupPath'"
    Write-Host ""
}

function Restore-Qdrant {
    Write-Host "=== Qdrant Restore ===" -ForegroundColor Cyan

    # Find latest backup
    if (-not (Test-Path -LiteralPath $BackupDir)) {
        throw "Backup directory not found: $BackupDir"
    }

    # If BackupDir points to a specific backup folder, use it. Otherwise find latest.
    $backupPath = $BackupDir
    if ((Get-Item $BackupDir).PSIsContainer -and (Test-Path (Join-Path $BackupDir "metadata.json"))) {
        # BackupDir is already a specific backup folder
    } else {
        $latestBackup = Get-ChildItem -Directory -Path $BackupDir | Sort-Object Name -Descending | Select-Object -First 1
        if (-not $latestBackup) {
            throw "No backup folders found in $BackupDir"
        }
        $backupPath = $latestBackup.FullName
    }

    Write-Host "Using backup: $backupPath"

    # Read metadata
    $metadataFile = Join-Path $backupPath "metadata.json"
    if (-not (Test-Path -LiteralPath $metadataFile)) {
        throw "metadata.json not found in backup folder"
    }
    $metadata = Get-Content -LiteralPath $metadataFile | ConvertFrom-Json

    Write-Host "Backup info:"
    Write-Host "  Timestamp: $($metadata.timestamp)"
    Write-Host "  Collection: $($metadata.collection)"
    Write-Host "  Snapshot: $($metadata.snapshot_file)"

    # Check Qdrant health
    Write-Host "Checking Qdrant health at $QdrantUrl..." -NoNewline
    if (-not (Test-QdrantHealth $QdrantUrl)) {
        Write-Host " FAILED" -ForegroundColor Red
        throw "Qdrant is not reachable at $QdrantUrl. Start it first: docker compose up -d qdrant"
    }
    Write-Host " OK" -ForegroundColor Green

    # 1. Upload snapshot
    $snapshotFile = Join-Path $backupPath $metadata.snapshot_file
    if (-not (Test-Path -LiteralPath $snapshotFile)) {
        throw "Snapshot file not found: $snapshotFile"
    }

    Write-Host "Uploading snapshot..." -NoNewline
    $snapshotBytes = [System.IO.File]::ReadAllBytes($snapshotFile)
    $boundary = [System.Guid]::NewGuid().ToString()
    $LF = "`r`n"

    $bodyLines = @(
        "--$boundary",
        "Content-Disposition: form-data; name=`"snapshot`"; filename=`"$($metadata.snapshot_file)`"",
        "Content-Type: application/octet-stream",
        "",
        ""
    )

    $bodyHeader = [System.Text.Encoding]::UTF8.GetBytes(($bodyLines -join $LF))
    $bodyFooter = [System.Text.Encoding]::UTF8.GetBytes("$LF--$boundary--$LF")

    $bodyStream = New-Object System.IO.MemoryStream
    $bodyStream.Write($bodyHeader, 0, $bodyHeader.Length)
    $bodyStream.Write($snapshotBytes, 0, $snapshotBytes.Length)
    $bodyStream.Write($bodyFooter, 0, $bodyFooter.Length)
    $body = $bodyStream.ToArray()

    try {
        Invoke-RestMethod `
            -Uri "$QdrantUrl/collections/$CollectionName/snapshots/upload" `
            -Method POST `
            -ContentType "multipart/form-data; boundary=$boundary" `
            -Body $body `
            -TimeoutSec 120 | Out-Null
        Write-Host " OK" -ForegroundColor Green
    } catch {
        Write-Host " FAILED" -ForegroundColor Red
        throw "Failed to upload snapshot: $($_.Exception.Message)"
    }

    # 2. Restore data directory
    $dataBackupFile = Join-Path $backupPath $metadata.data_backup
    if (Test-Path -LiteralPath $dataBackupFile) {
        Write-Host "Restoring .data directory..." -NoNewline
        Ensure-Dir $DataDir
        Expand-Archive -Path $dataBackupFile -DestinationPath $DataDir -Force
        Write-Host " OK" -ForegroundColor Green
    } else {
        Write-Host "WARNING: Data backup not found, skipping .data restore" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Restore completed successfully!" -ForegroundColor Green
    Write-Host "Your indexed data is now available at $QdrantUrl" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Ensure Ollama is running on the new machine"
    Write-Host "  2. Pull required models: ollama pull nomic-embed-text"
    Write-Host "  3. Start the server: npm start"
    Write-Host ""
}

# Main
switch ($Action) {
    "backup" { Backup-Qdrant }
    "restore" { Restore-Qdrant }
}
