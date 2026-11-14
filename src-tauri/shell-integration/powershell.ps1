# Nexterm shell integration for local PowerShell, passed with -NoExit -EncodedCommand
# (runs after the profile, so the profile's prompt is kept). OSC 133 A/C/D + OSC 633 E.
if ($Host.Name -eq 'ConsoleHost' -and -not $Global:__wtSi) {
    $Global:__wtSi = $true
    $Global:__wtPrompt = $function:prompt
    function Global:prompt {
        $ok = $?
        $code = if ($ok) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
        $e = [char]27; $b = [char]7
        "$e]133;D;$code$b$e]133;A$b" + (& $Global:__wtPrompt)
    }
    if (Get-Module PSReadLine) {
        # Called for every accepted line, right before it runs; the profile's handler still decides.
        $Global:__wtHist = (Get-PSReadLineOption).AddToHistoryHandler
        Set-PSReadLineOption -AddToHistoryHandler {
            param([string]$line)
            $bs = [string][char]92
            $c = $line.Replace($bs, $bs + $bs).Replace(';', $bs + 'x3b') -replace "`r?`n", ' '
            [Console]::Write("$([char]27)]633;E;$c$([char]7)$([char]27)]133;C$([char]7)")
            if ($Global:__wtHist) { & $Global:__wtHist $line } else { $true }
        }
    }
}
