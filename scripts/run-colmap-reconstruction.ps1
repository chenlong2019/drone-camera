[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CaptureDir,

  [Parameter(Mandatory = $false)]
  [string]$OutputDir,

  [string]$ColmapExe = 'colmap',

  [switch]$UseGpu,

  [ValidateRange(2, 2147483647)]
  [int]$MinRegisteredImages = 6,

  [ValidateRange(1, 2147483647)]
  [int]$MinSparsePoints = 100,

  [switch]$AllowSmallSparseModel
)

$ErrorActionPreference = 'Stop'

function Resolve-RequiredPath([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Label not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

$capture = Resolve-RequiredPath $CaptureDir 'Capture directory'
$manifestPath = Resolve-RequiredPath (Join-Path $capture 'manifest.json') 'manifest.json'
$images = Resolve-RequiredPath (Join-Path $capture 'images') 'images directory'
$colmapCommand = Get-Command $ColmapExe -ErrorAction SilentlyContinue
if ($null -eq $colmapCommand -and -not (Test-Path -LiteralPath $ColmapExe)) {
  throw "COLMAP executable was not found: $ColmapExe. Install COLMAP or pass -ColmapExe with the full path to colmap.exe."
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$manifestImages = @($manifest.images)

if ($manifest.schemaVersion -ne 1) {
  throw "Unsupported manifest schemaVersion: $($manifest.schemaVersion)"
}
if ($manifestImages.Count -lt 3) {
  throw 'At least three captured images are required for SfM.'
}
$camera = $manifest.camera
if ($camera.model -ne 'PINHOLE' -or $null -eq $camera.fx -or $null -eq $camera.fy -or $null -eq $camera.cx -or $null -eq $camera.cy) {
  throw 'This helper requires a PINHOLE manifest with fx, fy, cx and cy.'
}

$missing = @($manifestImages | ForEach-Object {
  $relative = [string]$_.file
  $relative = $relative -replace '/', '\'
  $candidate = Join-Path $capture $relative
  if (-not (Test-Path -LiteralPath $candidate)) { $relative }
})
if ($missing.Count -gt 0) {
  throw "Manifest image files are missing: $($missing -join ', ')"
}

$OutputDir = if ([string]::IsNullOrWhiteSpace($OutputDir)) { Join-Path $capture 'reconstruction' } else { $OutputDir }
$null = New-Item -ItemType Directory -Force -Path $OutputDir
$output = (Resolve-Path -LiteralPath $OutputDir).Path
$database = Join-Path $output 'database.db'
$sparse = Join-Path $output 'sparse'
$dense = Join-Path $output 'dense'
$mesh = Join-Path $output 'mesh'
$reportPath = Join-Path $output 'reconstruction-report.json'
$logPath = Join-Path $output 'reconstruction.log'
Set-Content -LiteralPath $logPath -Value '' -Encoding utf8
$invariant = [Globalization.CultureInfo]::InvariantCulture
$cameraParams = @($camera.fx, $camera.fy, $camera.cx, $camera.cy) | ForEach-Object {
  ([double]$_).ToString('R', $invariant)
}
$cameraParams = $cameraParams -join ','
$started = (Get-Date).ToUniversalTime().ToString('o')
$stage = 'validate-images'
$model = $null
$modelStats = $null
$colmapVersion = $null
$gpuBuild = $null
$helpCache = @{}

function Invoke-Colmap([string[]]$Arguments, [string]$Stage, [switch]$CaptureOutput) {
  $script:stage = $Stage
  $commandLine = "[$Stage] $ColmapExe $($Arguments -join ' ')"
  Write-Host $commandLine
  $lines = [System.Collections.Generic.List[string]]::new()
  $writer = [System.IO.StreamWriter]::new($logPath, $true, [System.Text.UTF8Encoding]::new($false))
  $writer.AutoFlush = $true
  $writer.WriteLine($commandLine)
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell wraps native stderr as ErrorRecord even for normal
    # COLMAP progress/help. Capture it as text and use the process exit code.
    $ErrorActionPreference = 'Continue'
    & $ColmapExe @Arguments 2>&1 | ForEach-Object {
      $line = $_.ToString()
      $writer.WriteLine($line)
      if ($CaptureOutput) { $lines.Add($line) } else { Write-Host $line }
    }
    $exitCode = $LASTEXITCODE
    $writer.WriteLine("[$Stage] exit code $exitCode")
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $writer.Dispose()
  }
  if ($exitCode -ne 0) { throw "COLMAP stage failed ($Stage), exit code $exitCode. See $logPath" }
  if ($CaptureOutput) { return ($lines -join [Environment]::NewLine) }
}

function Find-Option([string]$Command, [string[]]$Candidates) {
  if (-not $helpCache.ContainsKey($Command)) {
    $helpCache[$Command] = Invoke-Colmap @($Command, '-h') 'environment' -CaptureOutput
  }
  foreach ($candidate in $Candidates) {
    if ($helpCache[$Command] -match [regex]::Escape($candidate)) { return $candidate }
  }
  return $null
}

function Read-ModelCount([string]$Path) {
  # COLMAP images.bin and points3D.bin both start with a little-endian uint64
  # record count in 3.x and 4.x. File sizes also include observations/tracks
  # and therefore cannot be used to rank image or point counts.
  $reader = [System.IO.BinaryReader]::new([System.IO.File]::OpenRead($Path))
  try {
    return $reader.ReadUInt64()
  } finally {
    $reader.Dispose()
  }
}

function Get-SparseModelStats([string]$ModelPath) {
  return [pscustomobject]@{
    path = $ModelPath
    registeredImages = Read-ModelCount (Join-Path $ModelPath 'images.bin')
    sparsePoints = Read-ModelCount (Join-Path $ModelPath 'points3D.bin')
  }
}

try {
  # Help for patch_match_stereo also succeeds in CPU-only builds. The build
  # banner is what identifies the missing backend. Check before deleting any
  # previous reconstruction, and regardless of the SIFT -UseGpu setting.
  $help = Invoke-Colmap @('-h') 'environment' -CaptureOutput
  $colmapVersion = ($help -split '\r?\n' | Where-Object { $_ -match 'COLMAP \d' } | Select-Object -First 1)
  if ($colmapVersion -match '(?i)\bwithout\s+(GPU|CUDA|HIP)\b') {
    $gpuBuild = $false
    throw 'This COLMAP build has no GPU support. patch_match_stereo requires a CUDA/HIP-enabled build and compatible hardware. Install a GPU-enabled COLMAP build for your GPU (GTX 10-series requires a build supporting Pascal, e.g. CUDA 12). -UseGpu only controls SIFT; it cannot enable dense reconstruction in this build. Existing reconstruction data was preserved.'
  }
  if ($colmapVersion -match '(?i)\bwith\s+(GPU|CUDA|HIP)\b') { $gpuBuild = $true }

  $featureGpuOption = Find-Option 'feature_extractor' @('--SiftExtraction.use_gpu', '--FeatureExtraction.use_gpu')
  $matchingGpuOption = Find-Option 'exhaustive_matcher' @('--SiftMatching.use_gpu', '--FeatureMatching.use_gpu')
  $featureGpuArgs = if ($null -ne $featureGpuOption) { @($featureGpuOption, $(if ($UseGpu) { '1' } else { '0' })) } else { @() }
  $matchingGpuArgs = if ($null -ne $matchingGpuOption) { @($matchingGpuOption, $(if ($UseGpu) { '1' } else { '0' })) } else { @() }

  $stage = 'prepare-output'
  $outputPrefix = $output.TrimEnd('\') + '\'
  foreach ($stalePath in @($database, $sparse, $dense, $mesh)) {
    if (Test-Path -LiteralPath $stalePath) {
      $resolved = (Resolve-Path -LiteralPath $stalePath).Path
      if (-not $resolved.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup path is outside the output directory: $resolved"
      }
      if ((Get-Item -LiteralPath $resolved).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to clean a linked output path: $resolved"
      }
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }

  $featureArguments = @(
    'feature_extractor', '--database_path', $database, '--image_path', $images,
    '--ImageReader.single_camera', '1', '--ImageReader.camera_model', 'PINHOLE',
    '--ImageReader.camera_params', $cameraParams
  ) + $featureGpuArgs
  Invoke-Colmap $featureArguments 'feature-extraction'

  $matchingArguments = @('exhaustive_matcher', '--database_path', $database) + $matchingGpuArgs
  Invoke-Colmap $matchingArguments 'matching'

  $null = New-Item -ItemType Directory -Force -Path $sparse
  # The validation set is small and mostly planar. Relax only the seed and
  # pose thresholds enough to form a model; inspect registered-image counts
  # and geometry before treating the output as a usable reconstruction.
  Invoke-Colmap @(
    'mapper', '--database_path', $database, '--image_path', $images, '--output_path', $sparse,
    '--Mapper.multiple_models', '1',
    '--Mapper.min_model_size', '3',
    '--Mapper.init_min_num_inliers', '10',
    '--Mapper.min_num_matches', '5',
    '--Mapper.init_min_tri_angle', '0.1',
    '--Mapper.tri_min_angle', '0.1',
    '--Mapper.abs_pose_min_num_inliers', '5',
    '--Mapper.abs_pose_min_inlier_ratio', '0.05',
    '--Mapper.filter_max_reproj_error', '8'
  ) 'sfm'
  $modelDirectories = @(Get-ChildItem -LiteralPath $sparse -Directory | Where-Object { $_.Name -match '^\d+$' })
  if ($modelDirectories.Count -eq 0) { throw 'COLMAP mapper did not produce a sparse model directory.' }
  $stage = 'sparse-quality'
  $modelStats = $modelDirectories |
    ForEach-Object { Get-SparseModelStats $_.FullName } |
    Sort-Object `
      @{ Expression = { $_.sparsePoints }; Descending = $true },
      @{ Expression = { $_.registeredImages }; Descending = $true } |
    Select-Object -First 1
  $model = $modelStats.path
  $qualityMessage = "[sparse-quality] model $([System.IO.Path]::GetFileName($model)): $($modelStats.registeredImages) registered images, $($modelStats.sparsePoints) points"
  Write-Host $qualityMessage
  Add-Content -LiteralPath $logPath -Value $qualityMessage -Encoding utf8
  if (-not $AllowSmallSparseModel -and ($modelStats.registeredImages -lt $MinRegisteredImages -or $modelStats.sparsePoints -lt $MinSparsePoints)) {
    throw "Sparse model is too small for dense reconstruction: $($modelStats.registeredImages) registered images and $($modelStats.sparsePoints) points. Need at least $MinRegisteredImages registered images and $MinSparsePoints points; capture more continuous, overlapping views, or pass -AllowSmallSparseModel to try dense anyway."
  }

  $null = New-Item -ItemType Directory -Force -Path $dense
  Invoke-Colmap @('image_undistorter', '--image_path', $images, '--input_path', $model, '--output_path', $dense, '--output_type', 'COLMAP') 'undistort'
  Invoke-Colmap @('patch_match_stereo', '--workspace_path', $dense, '--workspace_format', 'COLMAP', '--PatchMatchStereo.geom_consistency', '1') 'dense'
  Invoke-Colmap @('stereo_fusion', '--workspace_path', $dense, '--workspace_format', 'COLMAP', '--input_type', 'geometric', '--output_path', (Join-Path $dense 'fused.ply')) 'fusion'

  $null = New-Item -ItemType Directory -Force -Path $mesh
  Invoke-Colmap @('poisson_mesher', '--input_path', (Join-Path $dense 'fused.ply'), '--output_path', (Join-Path $mesh 'poisson.ply')) 'mesh'
  $status = 'succeeded'
  $errors = @()
} catch {
  $status = 'failed'
  $errors = @($_.Exception.Message)
  $failure = "COLMAP reconstruction failed at ${stage}: $($_.Exception.Message)"
  Write-Warning $failure
  Add-Content -LiteralPath $logPath -Value $failure -Encoding utf8
}

$finished = (Get-Date).ToUniversalTime().ToString('o')
$report = [ordered]@{
  captureId = [string]$manifest.captureId
  status = $status
  stage = if ($status -eq 'succeeded') { 'mesh' } else { $stage }
  startedAt = $started
  finishedAt = $finished
  totalImages = [int]$manifestImages.Count
  colmapVersion = $colmapVersion
  gpuBuild = $gpuBuild
  logPath = $logPath
  sparseModel = if ($null -ne $model) { [System.IO.Path]::GetFileName($model) } else { $null }
  registeredImages = if ($null -ne $modelStats) { [int]$modelStats.registeredImages } else { $null }
  sparsePoints = if ($null -ne $modelStats) { [int]$modelStats.sparsePoints } else { $null }
  errors = $errors
  warnings = @('COLMAP output is not a 3D Tiles tileset; convert and visually inspect it before loading in Cesium.')
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host "Report: $reportPath"
Write-Host "Log: $logPath"
if ($status -ne 'succeeded') { exit 1 }
Write-Host "Reconstruction finished. Report: $reportPath"
