[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CaptureDir,

  [Parameter(Mandatory = $false)]
  [string]$OutputDir,

  [string]$ColmapExe = 'colmap',

  [switch]$UseGpu,

  [int]$MinRegisteredImages = 6,

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
$inspection = Join-Path $output 'sparse-inspection'
$stalePaths = @($database, $sparse, $dense, $mesh, $inspection)
foreach ($stalePath in $stalePaths) {
  if (Test-Path -LiteralPath $stalePath) {
    Remove-Item -LiteralPath $stalePath -Recurse -Force
  }
}
$invariant = [Globalization.CultureInfo]::InvariantCulture
$cameraParams = @($camera.fx, $camera.fy, $camera.cx, $camera.cy) | ForEach-Object {
  ([double]$_).ToString('R', $invariant)
}
$cameraParams = $cameraParams -join ','
$started = (Get-Date).ToUniversalTime().ToString('o')
$stage = 'validate-images'
$model = $null
$modelStats = $null

function Invoke-Colmap([string[]]$Arguments, [string]$Stage) {
  $script:stage = $Stage
  Write-Host "[$Stage] colmap $($Arguments -join ' ')"
  & $ColmapExe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "COLMAP stage failed ($Stage), exit code $LASTEXITCODE" }
}

function Find-Option([string]$Command, [string[]]$Candidates) {
  # COLMAP changed the SIFT GPU option names across releases. Resolve the
  # option from this installation instead of making one version-specific flag
  # mandatory for every run.
  # Some Windows builds print the help banner to stderr. With the script's
  # global Stop policy, that normal output becomes a terminating error, so
  # temporarily allow the native probe to complete and capture both streams.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $help = (& $ColmapExe $Command '-h' 2>&1 | Out-String)
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  foreach ($candidate in $Candidates) {
    if ($help -match [regex]::Escape($candidate)) { return $candidate }
  }
  return $null
}

function Get-SparseModelStats([string]$ModelPath, [string]$InspectionPath) {
  # COLMAP 4.x stores registered images and points in binary files whose
  # layout changed between releases. Convert a copy to TXT so the quality
  # gate works across supported Windows builds without parsing those files.
  $null = New-Item -ItemType Directory -Force -Path $InspectionPath
  $previousErrorActionPreference = $ErrorActionPreference
  $exitCode = 1
  try {
    $ErrorActionPreference = 'Continue'
    & $ColmapExe 'model_converter' '--input_path' $ModelPath '--output_path' $InspectionPath '--output_type' 'TXT' 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $imagesTxt = Join-Path $InspectionPath 'images.txt'
  $pointsTxt = Join-Path $InspectionPath 'points3D.txt'
  if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $imagesTxt) -or -not (Test-Path -LiteralPath $pointsTxt)) {
    return $null
  }

  $registeredImages = 0
  foreach ($line in Get-Content -LiteralPath $imagesTxt) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
    $parts = $line.Trim() -split '\s+'
    # An image record has 10 fields; the last field is the image name. The
    # following points2D record contains only numeric fields, so this avoids
    # counting it as a second image.
    if ($parts.Count -ge 10 -and $parts[0] -match '^-?\d+$' -and $parts[9] -notmatch '^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$') {
      $registeredImages++
    }
  }

  $sparsePoints = 0
  foreach ($line in Get-Content -LiteralPath $pointsTxt) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 8 -and $parts[0] -match '^-?\d+$') { $sparsePoints++ }
  }
  return [pscustomobject]@{
    registeredImages = $registeredImages
    sparsePoints = $sparsePoints
  }
}

$featureGpuOption = Find-Option 'feature_extractor' @('--SiftExtraction.use_gpu', '--FeatureExtraction.use_gpu')
$matchingGpuOption = Find-Option 'exhaustive_matcher' @('--SiftMatching.use_gpu', '--FeatureMatching.use_gpu')
if ($UseGpu -and $null -eq $featureGpuOption -and $null -eq $matchingGpuOption) {
  Write-Warning 'This COLMAP version does not expose SIFT GPU switches; COLMAP will choose its default acceleration mode.'
}
$featureGpuArgs = if ($null -ne $featureGpuOption) { @($featureGpuOption, $(if ($UseGpu) { '1' } else { '0' })) } else { @() }
$matchingGpuArgs = if ($null -ne $matchingGpuOption) { @($matchingGpuOption, $(if ($UseGpu) { '1' } else { '0' })) } else { @() }

try {
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
  # COLMAP may write model 1 (or another id) instead of always model 0.
  # Prefer reconstructed 3D points, then registered-frame data. images.bin
  # size is not a reliable image-count proxy because binary records vary.
  $model = $modelDirectories |
    Sort-Object `
      @{ Expression = { $file = Join-Path $_.FullName 'points3D.bin'; if (Test-Path -LiteralPath $file) { (Get-Item -LiteralPath $file).Length } else { 0 } }; Descending = $true },
      @{ Expression = { $file = Join-Path $_.FullName 'frames.bin'; if (Test-Path -LiteralPath $file) { (Get-Item -LiteralPath $file).Length } else { 0 } }; Descending = $true } |
    Select-Object -First 1 |
    Select-Object -ExpandProperty FullName

  $stage = 'sparse-quality'
  $modelStats = Get-SparseModelStats $model $inspection
  if ($null -eq $modelStats) {
    throw "Unable to inspect sparse model '$model'. COLMAP model_converter did not produce images.txt and points3D.txt."
  }
  Write-Host "[sparse-quality] model $([System.IO.Path]::GetFileName($model)): $($modelStats.registeredImages) registered images, $($modelStats.sparsePoints) points"
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
  Write-Warning "COLMAP reconstruction failed at ${stage}: $($_.Exception.Message)"
}

$finished = (Get-Date).ToUniversalTime().ToString('o')
$report = [ordered]@{
  captureId = [string]$manifest.captureId
  status = $status
  stage = if ($status -eq 'succeeded') { 'mesh' } else { $stage }
  startedAt = $started
  finishedAt = $finished
  totalImages = [int]$manifestImages.Count
  sparseModel = if ($null -ne $model) { [System.IO.Path]::GetFileName($model) } else { $null }
  registeredImages = if ($null -ne $modelStats) { [int]$modelStats.registeredImages } else { $null }
  sparsePoints = if ($null -ne $modelStats) { [int]$modelStats.sparsePoints } else { $null }
  errors = $errors
  warnings = @('COLMAP output is not a 3D Tiles tileset; convert and visually inspect it before loading in Cesium.')
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
if ($status -ne 'succeeded') { exit 1 }
Write-Host "Reconstruction finished. Report: $reportPath"
