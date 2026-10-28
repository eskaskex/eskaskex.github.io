$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'

  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(79, 70, 229))
  $g.FillRectangle($brush, 0, 0, $size, $size)

  $letter = [char]0x042D  # Э
  $fontSize = [int]($size * 0.55)
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'
  $sf.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF(0, (-$size * 0.02), $size, $size)
  $g.DrawString($letter, $font, [System.Drawing.Brushes]::White, $rect, $sf)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "OK $path"
}

New-Item -ItemType Directory -Force -Path 'icons' | Out-Null
New-Icon 192 'icons\icon-192.png'
New-Icon 512 'icons\icon-512.png'
