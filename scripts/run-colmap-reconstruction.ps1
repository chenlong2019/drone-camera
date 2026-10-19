[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CaptureDir,

  [Parameter(Mandatory = $false)]
  [string]$OutputDir,

  [string]$ColmapExe = 'colmap',

  [switch]$UseGpu
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
$gpuFlag = if ($UseGpu) { '1' } else { '0' }
$invariant = [Globalization.CultureInfo]::InvariantCulture
$cameraParams = @($camera.fx, $camera.fy, $camera.cx, $camera.cy) | ForEach-Object {
  ([double]$_).ToString('R', $invariant)
}
$cameraParams = $cameraParams -join ','
$started = (Get-Date).ToUniversalTime().ToString('o')
$stage = 'validate-images'

function Invoke-Colmap([string[]]$Arguments, [string]$Stage) {
  $script:stage = $Stage
  Write-Host "[$Stage] colmap $($Arguments -join ' ')"
  & $ColmapExe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "COLMAP stage failed ($Stage), exit code $LASTEXITCODE" }
}

try {
  Invoke-Colmap @(
    'feature_extractor', '--database_path', $database, '--image_path', $images,
    '--ImageReader.single_camera', '1', '--ImageReader.camera_model', 'PINHOLE',
    '--ImageReader.camera_params', $cameraParams, '--SiftExtraction.use_gpu', $gpuFlag
  ) 'feature-extraction'
  Invoke-Colmap @('exhaustive_matcher', '--database_path', $database, '--SiftMatching.use_gpu', $gpuFlag) 'matching'

  $null = New-Item -ItemType Directory -Force -Path $sparse
  Invoke-Colmap @('mapper', '--database_path', $database, '--image_path', $images, '--output_path', $sparse) 'sfm'
  $model = Join-Path $sparse '0'
  if (-not (Test-Path -LiteralPath $model)) { throw 'COLMAP mapper did not produce sparse/0.' }

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
  errors = $errors
  warnings = @('COLMAP output is not a 3D Tiles tileset; convert and visually inspect it before loading in Cesium.')
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
if ($status -ne 'succeeded') { exit 1 }
Write-Host "Reconstruction finished. Report: $reportPath"
