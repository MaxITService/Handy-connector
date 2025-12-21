param(
  [int]$Port = 55155,
  [int]$MaxAttempts = 20
)

$listener = $null
$actualPort = $null
$requestedPort = $Port

for ($attempt = 0; $attempt -lt $MaxAttempts; $attempt++) {
  $candidatePort = $requestedPort + $attempt
  $listener = [System.Net.HttpListener]::new()
  $listener.Prefixes.Add("http://127.0.0.1:$candidatePort/")
  $listener.Prefixes.Add("http://localhost:$candidatePort/")
  try {
    $listener.Start()
    $actualPort = $candidatePort
    break
  } catch {
    $errorCode = $_.Exception.ErrorCode
    $listener.Close()
    $listener = $null
    if ($errorCode -eq 32) {
      Write-Host "Port $candidatePort is busy. Trying next port..."
      continue
    }
    if ($errorCode -eq 5) {
      Write-Error ("Access denied starting listener on port {0}. Try running as admin or reserve the URL with: " -f $candidatePort)
      Write-Error ("  netsh http add urlacl url=http://127.0.0.1:{0}/ user={1}" -f $candidatePort, $env:USERNAME)
      return
    }
    Write-Error ("Failed to start HTTP listener on port {0}. {1}" -f $candidatePort, $_.Exception.Message)
    return
  }
}

if (-not $listener -or -not $listener.IsListening) {
  $lastPort = $requestedPort + $MaxAttempts - 1
  Write-Error "Could not bind to a free port in range $requestedPort..$lastPort."
  return
}

$Port = $actualPort

if ($Port -ne $requestedPort) {
  Write-Host "Requested port $requestedPort was busy. Using port $Port instead."
}

Write-Host "Handy test server listening on http://127.0.0.1:$Port"
Write-Host ("POST http://127.0.0.1:{0}/messages with {1} to queue a message." -f $Port, '{"text":"hello"}')

$messages = New-Object System.Collections.Generic.List[object]
$maxMessages = 500

function Set-CommonHeaders {
  param([System.Net.HttpListenerResponse]$Response)
  $Response.Headers["Access-Control-Allow-Origin"] = "*"
  $Response.Headers["Access-Control-Allow-Headers"] = "Content-Type"
  $Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
  $Response.Headers["Cache-Control"] = "no-store"
}

function Read-RequestBody {
  param([System.Net.HttpListenerRequest]$Request)
  if (-not $Request.HasEntityBody) {
    return ""
  }
  $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
  $body = $reader.ReadToEnd()
  $reader.Close()
  return $body
}

function Write-JsonResponse {
  param(
    [System.Net.HttpListenerContext]$Context,
    [int]$StatusCode,
    $Payload
  )
  $response = $Context.Response
  $response.StatusCode = $StatusCode
  $response.ContentType = "application/json; charset=utf-8"
  Set-CommonHeaders $response

  $json = $Payload | ConvertTo-Json -Depth 6 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.Close()
}

function Write-EmptyResponse {
  param(
    [System.Net.HttpListenerContext]$Context,
    [int]$StatusCode
  )
  $response = $Context.Response
  $response.StatusCode = $StatusCode
  Set-CommonHeaders $response
  $response.Close()
}

function Get-PropertyValue {
  param($Object, [string[]]$Names)
  foreach ($name in $Names) {
    if ($Object.PSObject.Properties.Name -contains $name) {
      return $Object.$name
    }
  }
  return $null
}

function Try-ParseLong {
  param($Value)
  if ($null -eq $Value) {
    return $null
  }
  $parsed = 0
  if ([long]::TryParse($Value.ToString(), [ref]$parsed)) {
    return $parsed
  }
  return $null
}

function Add-Message {
  param($Text, $Id, $Ts, $Raw)
  $safeText = if ($null -ne $Text) { [string]$Text } else { "" }
  $safeTs = Try-ParseLong $Ts
  if ($null -eq $safeTs) {
    $safeTs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  $safeId = if ($null -ne $Id -and $Id.ToString().Trim() -ne "") {
    $Id.ToString()
  } else {
    [Guid]::NewGuid().ToString("n")
  }

  $message = [ordered]@{
    id = $safeId
    text = $safeText
    ts = $safeTs
    raw = $Raw
  }

  [void]$messages.Add($message)
  if ($messages.Count -gt $maxMessages) {
    $messages.RemoveRange(0, $messages.Count - $maxMessages)
  }

  return $message
}

function Normalize-ItemToMessage {
  param($Item)
  if ($null -eq $Item) {
    return $null
  }
  if ($Item -is [string]) {
    return @{ text = $Item; raw = $Item }
  }
  if ($Item -isnot [psobject]) {
    return @{ text = $Item.ToString(); raw = $Item }
  }

  $text = Get-PropertyValue $Item @("text", "message", "body", "content")
  $id = Get-PropertyValue $Item @("id", "messageId", "uuid")
  $ts = Get-PropertyValue $Item @("ts", "time", "createdAt")

  if ($null -eq $text -or $text.ToString().Trim() -eq "") {
    $text = $Item | ConvertTo-Json -Depth 6 -Compress
  }

  return @{ text = $text; id = $id; ts = $ts; raw = $Item }
}

function Extract-MessageItems {
  param($Payload, [string]$RawText)
  $items = @()
  if ($null -ne $Payload) {
    if ($Payload -is [System.Array]) {
      $items = $Payload
    } elseif ($Payload.PSObject.Properties.Name -contains "messages") {
      $items = $Payload.messages
      if ($items -isnot [System.Array]) {
        $items = @($items)
      }
    } else {
      $items = @($Payload)
    }
  } elseif ($RawText -and $RawText.Trim() -ne "") {
    $items = @($RawText.Trim())
  }

  $result = @()
  foreach ($item in $items) {
    $normalized = Normalize-ItemToMessage $item
    if ($null -ne $normalized) {
      $result += $normalized
    }
  }

  return $result
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request

    if ($request.HttpMethod -eq "OPTIONS") {
      Write-EmptyResponse $context 204
      continue
    }

    $path = $request.Url.AbsolutePath.ToLowerInvariant()

    if ($path -eq "/health" -and $request.HttpMethod -eq "GET") {
      Write-JsonResponse $context 200 @{
        ok = $true
        now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      }
      continue
    }

    if ($path -eq "/messages" -and $request.HttpMethod -eq "POST") {
      $bodyText = Read-RequestBody $request
      $payload = $null
      if ($bodyText -and $bodyText.Trim() -ne "") {
        try {
          $payload = $bodyText | ConvertFrom-Json -ErrorAction Stop
        } catch {
          $payload = $null
        }
      }

      $items = Extract-MessageItems $payload $bodyText
      $stored = @()
      foreach ($item in $items) {
        $stored += Add-Message $item.text $item.id $item.ts $item.raw
      }

      Write-JsonResponse $context 200 @{
        ok = $true
        stored = $stored
      }
      continue
    }

    if ($path -eq "/messages" -and $request.HttpMethod -eq "GET") {
      $sinceRaw = $request.QueryString["since"]
      $sinceValue = Try-ParseLong $sinceRaw
      $filtered = if ($null -ne $sinceValue) {
        $messages | Where-Object { $_.ts -gt $sinceValue }
      } else {
        $messages
      }

      $nextCursor = $null
      if ($filtered.Count -gt 0) {
        $nextCursor = $filtered[$filtered.Count - 1].ts
      } elseif ($messages.Count -gt 0) {
        $nextCursor = $messages[$messages.Count - 1].ts
      }

      Write-JsonResponse $context 200 @{
        ok = $true
        messages = $filtered
        nextCursor = $nextCursor
      }
      continue
    }

    Write-JsonResponse $context 404 @{
      ok = $false
      error = "Not found"
    }
  }
} finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}
