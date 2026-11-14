# Memory of a terminal and its child processes (WebView2 for nexterm).
# Usage: .\mem.ps1 WindTerm   /   .\mem.ps1 nexterm
param([string]$Name, [int]$Ms = 250)
function Tree($id){ $id; Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | % { Tree $_.ProcessId } }
$root = (Get-Process $Name | Sort StartTime | Select -First 1).Id
$peak = 0
while ($true) {
  $p  = Get-Process -Id (Tree $root) -EA 0
  $pm = ($p | Measure PrivateMemorySize64 -Sum).Sum / 1MB
  $ws = ($p | Measure WorkingSet64 -Sum).Sum / 1MB
  if ($pm -gt $peak) { $peak = $pm }
  "{0:N1} MB private  (peak {1:N1})  WS {2:N1} MB  procs={3}" -f $pm,$peak,$ws,$p.Count
  Start-Sleep -m $Ms
}
