param([string]$Root = '.')
$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://localhost:4173/')
$listener.Start()
Write-Output "SecureX local server running at http://localhost:4173/"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $reqPath = $ctx.Request.Url.AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($reqPath)) { $reqPath = 'index.html' }
    $safePath = $reqPath -replace '/', '\\'
    $fullPath = Join-Path $rootPath $safePath

    if ((Test-Path $fullPath) -and ((Get-Item $fullPath).PSIsContainer -eq $false)) {
      $bytes = [System.IO.File]::ReadAllBytes($fullPath)
      $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
      switch ($ext) {
        '.html' { $ctx.Response.ContentType = 'text/html; charset=utf-8' }
        '.css'  { $ctx.Response.ContentType = 'text/css; charset=utf-8' }
        '.js'   { $ctx.Response.ContentType = 'application/javascript; charset=utf-8' }
        '.json' { $ctx.Response.ContentType = 'application/json; charset=utf-8' }
        '.svg'  { $ctx.Response.ContentType = 'image/svg+xml' }
        '.png'  { $ctx.Response.ContentType = 'image/png' }
        '.jpg'  { $ctx.Response.ContentType = 'image/jpeg' }
        '.jpeg' { $ctx.Response.ContentType = 'image/jpeg' }
        default { $ctx.Response.ContentType = 'application/octet-stream' }
      }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $ctx.Response.ContentType = 'text/plain; charset=utf-8'
      $ctx.Response.ContentLength64 = $msg.Length
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }

    $ctx.Response.OutputStream.Close()
  }
}
finally {
  $listener.Stop()
  $listener.Close()
}
