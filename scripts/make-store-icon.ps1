Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Drawing.Drawing2D

$size = 128
$out = Join-Path $PSScriptRoot '..\icons\store-128.png'

$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# rounded-square background with diagonal gradient
$radius = 22
$rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc($rect.Right - $radius, $rect.Y, $radius, $radius, 270, 90)
$path.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()

$c1 = [System.Drawing.Color]::FromArgb(255, 56, 130, 220)
$c2 = [System.Drawing.Color]::FromArgb(255, 22, 78, 150)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 135.0
$g.FillPath($grad, $path)

# funnel/filter glyph, centered
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$brush = New-Object System.Drawing.SolidBrush $white
$pen = New-Object System.Drawing.Pen $white, 8.0
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

# funnel outline (trapezoid into a stem)
$funnel = New-Object System.Drawing.Drawing2D.GraphicsPath
$points = @(
  (New-Object System.Drawing.PointF 30, 44),
  (New-Object System.Drawing.PointF 98, 44),
  (New-Object System.Drawing.PointF 72, 76),
  (New-Object System.Drawing.PointF 72, 102),
  (New-Object System.Drawing.PointF 56, 102),
  (New-Object System.Drawing.PointF 56, 76)
)
$funnel.AddPolygon($points)
$g.DrawPath($pen, $funnel)

# "AI sparkle" — small four-point star upper-right
$cx = 96.0; $cy = 30.0; $r1 = 10.0; $r2 = 3.5
$star = New-Object System.Drawing.Drawing2D.GraphicsPath
$starPts = @(
  (New-Object System.Drawing.PointF $cx, ($cy - $r1)),
  (New-Object System.Drawing.PointF ($cx + $r2), ($cy - $r2)),
  (New-Object System.Drawing.PointF ($cx + $r1), $cy),
  (New-Object System.Drawing.PointF ($cx + $r2), ($cy + $r2)),
  (New-Object System.Drawing.PointF $cx, ($cy + $r1)),
  (New-Object System.Drawing.PointF ($cx - $r2), ($cy + $r2)),
  (New-Object System.Drawing.PointF ($cx - $r1), $cy),
  (New-Object System.Drawing.PointF ($cx - $r2), ($cy - $r2))
)
$star.AddPolygon($starPts)
$g.FillPath($brush, $star)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()
$grad.Dispose()
$pen.Dispose()
$brush.Dispose()
Write-Host "wrote $out"
