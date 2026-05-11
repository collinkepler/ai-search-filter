Add-Type -AssemblyName System.Drawing
$sizes = 16, 32, 48, 128
$bg = [System.Drawing.Color]::FromArgb(255, 30, 100, 180)
$out = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $out | Out-Null
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear($bg)
  $fontSize = [Math]::Max(5, [int]($s * 0.26))
  $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold)
  $brush = [System.Drawing.Brushes]::White
  $fmt = New-Object System.Drawing.StringFormat ([System.Drawing.StringFormatFlags]::NoWrap)
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $fmt.Trimming = 'None'
  $rect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
  $g.DrawString('AISF', $font, $brush, $rect, $fmt)
  $path = Join-Path $out "$s.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "wrote $path"
}
