# Samples private memory of several terminals (whole process tree, incl. WebView2) into a CSV.
# Usage: .\mem-all.ps1 -Out mem.csv [-Names nexterm,NyaTerm,WindTerm] [-Ms 500]
param([string]$Out = "mem.csv", [string[]]$Names = @("nexterm", "NyaTerm", "WindTerm"), [int]$Ms = 500)
function Tree($id, $all) { $id; $all | ? { $_.ParentProcessId -eq $id } | % { Tree $_.ProcessId $all } }
"time,name,private_mb,ws_mb,procs" | Set-Content $Out
while ($true) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  foreach ($n in $Names) {
    $root = Get-Process $n -EA 0 | Sort StartTime | Select -First 1
    if (-not $root) { continue }
    $p = Get-Process -Id (Tree $root.Id $all) -EA 0
    $pm = ($p | Measure PrivateMemorySize64 -Sum).Sum / 1MB
    $ws = ($p | Measure WorkingSet64 -Sum).Sum / 1MB
    "{0},{1},{2:F1},{3:F1},{4}" -f $t, $n, $pm, $ws, $p.Count | Add-Content $Out
  }
  Start-Sleep -m $Ms
}
