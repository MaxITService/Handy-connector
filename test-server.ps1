param(
  [int]$Port = 63155,
  [int]$MaxAttempts = 20
)

# Shared state for background communication
# We use synchronized wrappers for lists to allow thread-safe simple adds/removes,
# but we still need explicit locking for enumeration or compound checking.
$state = [hashtable]::Synchronized(@{
    messages      = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
    acks          = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
    blobs         = [hashtable]::Synchronized(@{})
    maxMessages   = 500
    port          = $Port
    stop          = $false
    actualPort    = $null
    lastKeepalive = 0
    error         = $null
  })

$serverLogic = {
  param($state)
  
  $actualPort = $null
  $listener = $null
  
  try {
    # Port binding logic
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $candidatePort = $state.port + $attempt
      $listener = [System.Net.HttpListener]::new()
      $listener.Prefixes.Add("http://127.0.0.1:$candidatePort/")
      $listener.Prefixes.Add("http://localhost:$candidatePort/")
      try {
        $listener.Start()
        $actualPort = $candidatePort
        $state.actualPort = $actualPort
        break
      }
      catch {
        $listener.Close()
        $listener = $null
        continue
      }
    }

    if (-not $listener) { 
      $state.error = "Could not bind to any port."
      return 
    }

    function Set-Headers {
      param($r)
      $r.Headers["Access-Control-Allow-Origin"] = "*"
      $r.Headers["Access-Control-Allow-Headers"] = "*"
      $r.Headers["Access-Control-Allow-Methods"] = "*"
      $r.Headers["Methods"] = "GET, POST, OPTIONS" 
      $r.Headers["Cache-Control"] = "no-store"
    }

    # Helper for thread-safe locking locally in the background job
    function Lock-Invoke {
      param($Obj, $ScriptBlock)
      [System.Threading.Monitor]::Enter($Obj)
      try {
        & $ScriptBlock
      }
      finally {
        [System.Threading.Monitor]::Exit($Obj)
      }
    }

    function Get-MimeType {
      param([string]$FilePath)
      $ext = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
      switch ($ext) {
        ".png" { return "image/png" }
        ".jpg" { return "image/jpeg" }
        ".jpeg" { return "image/jpeg" }
        ".gif" { return "image/gif" }
        ".webp" { return "image/webp" }
        ".txt" { return "text/plain" }
        ".csv" { return "text/csv" }
        default { return "application/octet-stream" }
      }
    }

    function New-Attachment {
      param(
        [string]$FilePath,
        [string]$Kind
      )
      if (-not (Test-Path -LiteralPath $FilePath)) {
        throw "Attachment file not found: $FilePath"
      }

      $fileInfo = Get-Item -LiteralPath $FilePath
      $attId = [Guid]::NewGuid().ToString("n")
      $token = [Guid]::NewGuid().ToString("n")
      $expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeMilliseconds()
      $mime = Get-MimeType -FilePath $FilePath

      $record = @{
        path      = $FilePath
        mime      = $mime
        size      = $fileInfo.Length
        token     = $token
        expiresAt = $expiresAt
        usesLeft  = 3
      }

      Lock-Invoke $state.blobs.SyncRoot {
        $state.blobs[$attId] = $record
      }

      return @{
        attId    = $attId
        kind     = $Kind
        filename = $fileInfo.Name
        mime     = $mime
        size     = $fileInfo.Length
        fetch    = @{
          url       = "http://127.0.0.1:$($state.actualPort)/blob/$attId"
          method    = "GET"
          headers   = @{ "X-Token" = $token }
          expiresAt = $expiresAt
        }
      }
    }

    function New-MessageObject {
      param(
        [string]$Text,
        [string]$Type = "text",
        [object[]]$Attachments = $null,
        [object]$Raw = $null,
        [long]$Ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      )
      $msg = New-Object PSObject
      $msg | Add-Member -NotePropertyName id -NotePropertyValue ([Guid]::NewGuid().ToString("n")) -Force
      $msg | Add-Member -NotePropertyName type -NotePropertyValue $Type -Force
      $msg | Add-Member -NotePropertyName text -NotePropertyValue $Text -Force
      $msg | Add-Member -NotePropertyName ts -NotePropertyValue $Ts -Force
      if ($Attachments) {
        $msg | Add-Member -NotePropertyName attachments -NotePropertyValue $Attachments -Force
      }
      $msg | Add-Member -NotePropertyName raw -NotePropertyValue $Raw -Force
      return $msg
    }

    $pendingContext = $null

    while ($listener.IsListening -and -not $state.stop) {
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      
      # CHECK FOR KEEPALIVE NEED
      if ($now - $state.lastKeepalive -gt 15000) {
        $state.lastKeepalive = $now
        $ka = New-MessageObject -Text "keepalive" -Raw @{ type = "keepalive" } -Ts $now
        
        Lock-Invoke $state.messages.SyncRoot {
          [void]$state.messages.Add($ka)
          while ($state.messages.Count -gt $state.maxMessages) { [void]$state.messages.RemoveAt(0) }
        }
      }

      # CHECK FOR STALE CONNECTION (No Ack received recently)
      # We check the shared 'acks' timestamps or just use a local tracker updated when we process POSTs.
      # Since 'acks' list is populated in the POST handler, we need to check that.
      # Actually simpler: The main thread reads $state.acks. The background thread (this) WRITES to it.
      # The background thread processes the POST, so it knows when an Ack arrives.
      # We need to expose 'LastAckReceivedAt' in state to track it across threads if needed, 
      # but here we are in the single background thread loop.
      
      # Let's inspect $state.lastAckAt (we will add this property below in the POST handler)
      $lastAck = 0
      if ($state.ContainsKey("lastAckAt")) { $lastAck = $state.lastAckAt }
      
      # Warn if > 45 seconds since last ack (given keepalive is 15s)
      if ($lastAck -gt 0 -and ($now - $lastAck -gt 45000)) {
        # We can't write-host easily from background thread to main console without clutter, 
        # but we can push a 'system' message to the message list locally so it shows up?
        # Or better, update a status in $state that Main loop checks.
        $state.connectionStatus = "STALE"
      }
      else {
        $state.connectionStatus = "OK"
      }


      # Correct async pattern: keep a single pending accept and only complete it once.
      if (-not $pendingContext) {
        $pendingContext = $listener.BeginGetContext($null, $null)
      }
      if (-not $pendingContext.AsyncWaitHandle.WaitOne(500)) {
        continue
      }
      
      $context = $listener.EndGetContext($pendingContext)
      $pendingContext = $null
      $request = $context.Request
      $response = $context.Response
      $path = $request.Url.AbsolutePath.ToLowerInvariant().TrimEnd('/')
      
      Set-Headers $response

      if ($request.HttpMethod -eq "OPTIONS") {
        $response.StatusCode = 204
        $response.Close()
        continue
      }

      if ($path.StartsWith("/blob/") -and $request.HttpMethod -eq "GET") {
        $attId = $path.Substring(6)
        $blob = Lock-Invoke $state.blobs.SyncRoot {
          if ($state.blobs.ContainsKey($attId)) {
            $state.blobs[$attId]
          }
        }

        if (-not $blob) {
          $response.StatusCode = 404
          $response.Close()
          continue
        }

        $token = $request.Headers["X-Token"]
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if (-not $token -or $token -ne $blob.token) {
          $response.StatusCode = 403
          $response.Close()
          continue
        }
        if ($blob.expiresAt -and $now -gt $blob.expiresAt) {
          $response.StatusCode = 410
          $response.Close()
          continue
        }

        try {
          $bytes = [System.IO.File]::ReadAllBytes($blob.path)
          $response.ContentType = $blob.mime
          $response.ContentLength64 = $bytes.Length
          $response.OutputStream.Write($bytes, 0, $bytes.Length)

          Lock-Invoke $state.blobs.SyncRoot {
            if ($state.blobs.ContainsKey($attId)) {
              $blob.usesLeft = [Math]::Max(0, $blob.usesLeft - 1)
              if ($blob.usesLeft -le 0) {
                $state.blobs.Remove($attId) | Out-Null
              }
              else {
                $state.blobs[$attId] = $blob
              }
            }
          }
        }
        catch {
          $response.StatusCode = 500
        }
        $response.Close()
      }
      elseif ($path -eq "/messages" -and $request.HttpMethod -eq "GET") {
        # Polling for messages
        # Update connection tracker
        Lock-Invoke $state.messages.SyncRoot {
          $state.lastPoll = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }

        $since = 0
        if ($request.QueryString["since"]) { [long]::TryParse($request.QueryString["since"], [ref]$since) | Out-Null }
        
        $filtered = [System.Collections.Generic.List[object]]::new()

        $nextCursor = Lock-Invoke $state.messages.SyncRoot {
          foreach ($m in $state.messages) {
            if ($m.ts -gt $since) { [void]$filtered.Add($m) }
          }
          if ($filtered.Count -gt 0) {
            $filtered[$filtered.Count - 1].ts
          }
          elseif ($state.messages.Count -gt 0) {
            $state.messages[$state.messages.Count - 1].ts
          }
        }

        $payload = @{ cursor = $nextCursor; messages = $filtered.ToArray() }
        $json = $payload | ConvertTo-Json -Depth 6 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $response.ContentType = "application/json"
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
        $response.Close()
      }
      elseif ($path -eq "/messages" -and $request.HttpMethod -eq "POST") {
        # Receiving messages or ACKs
        $reader = New-Object System.IO.StreamReader($request.InputStream)
        $body = $reader.ReadToEnd()
        $msgText = $body
        $isAck = $false

        try {
          $jsonBody = $body | ConvertFrom-Json
          if ($jsonBody.text) { $msgText = $jsonBody.text }
          if ($jsonBody.type -eq "keepalive_ack") { $isAck = $true }
        }
        catch {}

        if ($isAck) {
          # Add to acks list for the main thread to display
          [void]$state.acks.Add("Ack received at $([DateTime]::Now.ToString('HH:mm:ss'))")
        }
        else {
          $nowTs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          $msg = New-MessageObject -Text $msgText -Ts $nowTs
             
          Lock-Invoke $state.messages.SyncRoot {
            [void]$state.messages.Add($msg)
            while ($state.messages.Count -gt $state.maxMessages) { [void]$state.messages.RemoveAt(0) }
          }
             
          # Also verify visually in server console for regular messages
          [void]$state.acks.Add("New message received: $msgText")
        }
        
        $payload = @{ ok = $true }
        $json = $payload | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
        $response.Close()
      }
      else {
        Write-Host "404 Not Found: $path (Method: $($request.HttpMethod))" -ForegroundColor Yellow
        $response.StatusCode = 404
        $response.Close()
      }
    }
  }
  catch {
    $state.error = $_.Exception.ToString()
  }
  finally {
    if ($listener) {
      if ($listener.IsListening) { $listener.Stop() }
      $listener.Close()
    }
  }
}

# Start the server in background
$ps = [PowerShell]::Create().AddScript($serverLogic).AddArgument($state)
$asyncResult = $ps.BeginInvoke()

# Wait for port to be assigned
Write-Host "Starting background server..." -NoNewline
while ($null -eq $state.actualPort -and -not $asyncResult.IsCompleted) {
  Write-Host "." -NoNewline
  Start-Sleep -Milliseconds 200
}
Write-Host ""

if ($state.error) {
  Write-Error "Server crashed on startup: $($state.error)"
  return
}

if ($null -eq $state.actualPort) {
  Write-Error "Failed to start server (unknown reason)."
  return
}

Write-Host "Server listening on http://127.0.0.1:$($state.actualPort)"
Write-Host "Keepalive active (every 15s). Waiting for 'Ack' from extension."
Write-Host "Type a message and press Enter to send."
Write-Host "Bundle shortcuts: test-image, test-file, test-csv, test-bundle."
Write-Host "Type 'exit' to stop."

function Lock-Invoke-Main {
  param($Obj, $ScriptBlock)
  [System.Threading.Monitor]::Enter($Obj)
  try {
    & $ScriptBlock
  }
  finally {
    [System.Threading.Monitor]::Exit($Obj)
  }
}

function Get-MimeType-Main {
  param([string]$FilePath)
  $ext = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
  switch ($ext) {
    ".png" { return "image/png" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".gif" { return "image/gif" }
    ".webp" { return "image/webp" }
    ".txt" { return "text/plain" }
    ".csv" { return "text/csv" }
    default { return "application/octet-stream" }
  }
}

function New-Attachment-Main {
  param(
    [string]$FilePath,
    [string]$Kind
  )
  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "Attachment file not found: $FilePath"
  }

  $fileInfo = Get-Item -LiteralPath $FilePath
  $attId = [Guid]::NewGuid().ToString("n")
  $token = [Guid]::NewGuid().ToString("n")
  $expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeMilliseconds()
  $mime = Get-MimeType-Main -FilePath $FilePath

  $record = @{
    path      = $FilePath
    mime      = $mime
    size      = $fileInfo.Length
    token     = $token
    expiresAt = $expiresAt
    usesLeft  = 3
  }

  Lock-Invoke-Main $state.blobs.SyncRoot {
    $state.blobs[$attId] = $record
  }

  return @{
    attId    = $attId
    kind     = $Kind
    filename = $fileInfo.Name
    mime     = $mime
    size     = $fileInfo.Length
    fetch    = @{
      url       = "http://127.0.0.1:$($state.actualPort)/blob/$attId"
      method    = "GET"
      headers   = @{ "X-Token" = $token }
      expiresAt = $expiresAt
    }
  }
}

function New-MessageObject-Main {
  param(
    [string]$Text,
    [string]$Type = "text",
    [object[]]$Attachments = $null,
    [object]$Raw = $null,
    [long]$Ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  )
  $msg = New-Object PSObject
  $msg | Add-Member -NotePropertyName id -NotePropertyValue ([Guid]::NewGuid().ToString("n")) -Force
  $msg | Add-Member -NotePropertyName type -NotePropertyValue $Type -Force
  $msg | Add-Member -NotePropertyName text -NotePropertyValue $Text -Force
  $msg | Add-Member -NotePropertyName ts -NotePropertyValue $Ts -Force
  if ($Attachments) {
    $msg | Add-Member -NotePropertyName attachments -NotePropertyValue $Attachments -Force
  }
  $msg | Add-Member -NotePropertyName raw -NotePropertyValue $Raw -Force
  return $msg
}

try {
  while ($true) {
    # Check for ACKs or Errors from background
    if ($state.error) {
      Write-Error "Background server error: $($state.error)"
      break
    }

    # Process and print any scheduled output (Acks or Incoming notices)
    while ($state.acks.Count -gt 0) {
      $ack = $state.acks[0]
      $state.acks.RemoveAt(0)
      Write-Host ">> $ack" -ForegroundColor Green
    }

    # Monitor Connection State based on lastPoll
    $nowMain = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $lastPoll = 0
    if ($state.ContainsKey("lastPoll")) { $lastPoll = $state.lastPoll }
    
    # State tracking for UI
    if (-not $script:clientConnected -and $lastPoll -gt 0 -and ($nowMain - $lastPoll -lt 5000)) {
      $script:clientConnected = $true
      Write-Host ">> Client Connected (Polling started)" -ForegroundColor Cyan
    }
    elseif ($script:clientConnected -and ($nowMain - $lastPoll -gt 10000)) {
      $script:clientConnected = $false
      Write-Host ">> Client Disconnected (No polls for 10s)" -ForegroundColor Red
    }

    # Non-blocking input handling using System.Console
    # Read-Host blocks, so we use KeyAvailable
    if ([System.Console]::KeyAvailable) {
      # We'll fall into Read-Host which blocks until newline, but that's acceptable
      # once the user STARTS typing.
      $inputVal = Read-Host "Input"
      if ($inputVal -eq "exit") { break }
      $inputTrim = $inputVal.Trim()
      if ($inputTrim -ne "") {
        $nowTs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($inputTrim -ieq "test-image") {
          $filePath = Join-Path $PSScriptRoot "demo-image.png"
          $attachments = @(New-Attachment-Main -FilePath $filePath -Kind "image")
          $msg = New-MessageObject-Main -Text "test-image ok" -Type "bundle" -Attachments $attachments -Ts $nowTs
        }
        elseif ($inputTrim -ieq "test-file") {
          $filePath = Join-Path $PSScriptRoot "demo-file.txt"
          $attachments = @(New-Attachment-Main -FilePath $filePath -Kind "file")
          $msg = New-MessageObject-Main -Text "test-file ok" -Type "bundle" -Attachments $attachments -Ts $nowTs
        }
        elseif ($inputTrim -ieq "test-csv") {
          $filePath = Join-Path $PSScriptRoot "demo-data.csv"
          $attachments = @(New-Attachment-Main -FilePath $filePath -Kind "file")
          $msg = New-MessageObject-Main -Text "test-csv ok" -Type "bundle" -Attachments $attachments -Ts $nowTs
        }
        elseif ($inputTrim -ieq "test-bundle") {
          $imagePath = Join-Path $PSScriptRoot "demo-image.png"
          $textPath = Join-Path $PSScriptRoot "demo-file.txt"
          $attachments = @(
            New-Attachment-Main -FilePath $imagePath -Kind "image"
            New-Attachment-Main -FilePath $textPath -Kind "file"
          )
          $msg = New-MessageObject-Main -Text "test-bundle ok" -Type "bundle" -Attachments $attachments -Ts $nowTs
        }
        else {
          $msg = New-MessageObject-Main -Text $inputTrim -Ts $nowTs
        }
            
        Lock-Invoke-Main $state.messages.SyncRoot {
          [void]$state.messages.Add($msg)
          while ($state.messages.Count -gt $state.maxMessages) { [void]$state.messages.RemoveAt(0) }
        }
        Write-Host "Sent: $($msg.text)"
      }
    }
    
    Start-Sleep -Milliseconds 100
  }
}
finally {
  $state.stop = $true
  Write-Host "Shutting down..."
  Start-Sleep -Seconds 1
  $ps.Stop()
  $ps.Dispose()
}
