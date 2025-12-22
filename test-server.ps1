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
      $r.Headers["Access-Control-Allow-Headers"] = "Content-Type"
      $r.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
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

    function New-MessageObject {
      param(
        [string]$Text,
        [object]$Raw = $null,
        [long]$Ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      )
      $msg = New-Object PSObject
      $msg | Add-Member -NotePropertyName id -NotePropertyValue ([Guid]::NewGuid().ToString("n")) -Force
      $msg | Add-Member -NotePropertyName text -NotePropertyValue $Text -Force
      $msg | Add-Member -NotePropertyName ts -NotePropertyValue $Ts -Force
      $msg | Add-Member -NotePropertyName raw -NotePropertyValue $Raw -Force
      return $msg
    }

    $pendingContext = $null
    while ($listener.IsListening -and -not $state.stop) {
      # CHECK FOR KEEPALIVE NEED
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($now - $state.lastKeepalive -gt 15000) {
        # 15 seconds
        $state.lastKeepalive = $now
        $ka = New-MessageObject -Text "keepalive" -Raw @{ type = "keepalive" } -Ts $now
        
        Lock-Invoke $state.messages.SyncRoot {
          [void]$state.messages.Add($ka)
          while ($state.messages.Count -gt $state.maxMessages) { [void]$state.messages.RemoveAt(0) }
        }
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
      $path = $request.Url.AbsolutePath.ToLowerInvariant()
      
      Set-Headers $response

      if ($request.HttpMethod -eq "OPTIONS") {
        $response.StatusCode = 204
        $response.Close()
        continue
      }

      if ($path -eq "/messages" -and $request.HttpMethod -eq "GET") {
        # Polling for messages
        $since = 0
        if ($request.QueryString["since"]) { [long]::TryParse($request.QueryString["since"], [ref]$since) | Out-Null }
        
        $filtered = [System.Collections.Generic.List[object]]::new()
        $nextCursor = $null

        Lock-Invoke $state.messages.SyncRoot {
          foreach ($m in $state.messages) {
            if ($m.ts -gt $since) { [void]$filtered.Add($m) }
          }
          if ($filtered.Count -gt 0) { 
            $nextCursor = $filtered[$filtered.Count - 1].ts 
          }
          elseif ($state.messages.Count -gt 0) {
            $nextCursor = $state.messages[$state.messages.Count - 1].ts 
          }
        }

        # Handle null cursor strictly for JSON
        if ($null -eq $nextCursor) { $nextCursor = $null }

        $payload = @{ ok = $true; messages = $filtered.ToArray(); nextCursor = $nextCursor }
        $json = $payload | ConvertTo-Json -Depth 6 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $response.ContentType = "application/json"
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
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
      }
      else {
        $response.StatusCode = 404
      }
      $response.Close()
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

function New-MessageObject-Main {
  param(
    [string]$Text,
    [object]$Raw = $null,
    [long]$Ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  )
  $msg = New-Object PSObject
  $msg | Add-Member -NotePropertyName id -NotePropertyValue ([Guid]::NewGuid().ToString("n")) -Force
  $msg | Add-Member -NotePropertyName text -NotePropertyValue $Text -Force
  $msg | Add-Member -NotePropertyName ts -NotePropertyValue $Ts -Force
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

    # Non-blocking input handling using System.Console
    # Read-Host blocks, so we use KeyAvailable
    if ([System.Console]::KeyAvailable) {
      # We'll fall into Read-Host which blocks until newline, but that's acceptable
      # once the user STARTS typing.
      $inputVal = Read-Host "Input"
      if ($inputVal -eq "exit") { break }
      if ($inputVal.Trim() -ne "") {
        $nowTs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $msg = New-MessageObject-Main -Text $inputVal -Ts $nowTs
            
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
