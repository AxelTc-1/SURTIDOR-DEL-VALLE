param(
  [string]$ZipName = "maqtio_upload.zip"
)

Write-Host "[ZIP] Preparando paquete $ZipName" -ForegroundColor Cyan
$root = Get-Location
$zipPath = Join-Path $root $ZipName
if(Test-Path $zipPath){ Remove-Item $zipPath -Force }

$temp = Join-Path $env:TEMP ("maqtio_package_" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null

$excludeDirs = @('node_modules', '.git', '.vscode')
$excludeFiles = @('.env','maqtio_upload.zip')

Get-ChildItem -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Path.Length).TrimStart('\\')
  $parts = $rel.Split([io.path]::DirectorySeparatorChar)
  if($excludeFiles -contains $_.Name){ return $false }
  foreach($p in $parts){ if($excludeDirs -contains $p){ return $false } }
  return $true
} | ForEach-Object {
  $rel = $_.FullName.Substring($root.Path.Length).TrimStart('\\')
  $dest = Join-Path $temp $rel
  $destDir = Split-Path $dest -Parent
  if(!(Test-Path $destDir)){ New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  Copy-Item $_.FullName $dest -Force
}

Compress-Archive -Path (Join-Path $temp '*') -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "[ZIP] Creado: $zipPath" -ForegroundColor Green
Write-Host "[ZIP] Tamaño:" ((Get-Item $zipPath).Length/1KB).ToString('0.0') 'KB'

# Limpieza
Remove-Item $temp -Recurse -Force
