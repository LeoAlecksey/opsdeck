# OpsDeck shell integration for PowerShell (Windows PowerShell 5.1 and PowerShell 7).
# Emits OSC 133 marks (A prompt, B command input, C output, D;exit), OSC 133;E;<base64 command>
# and OSC 7 (cwd) so the terminal can build command blocks and suggest commands.
# Loaded after the user's profile: the user's prompt is wrapped, not replaced.

if ($Global:__OpsDeckSI) { return }
$Global:__OpsDeckSI = $true
$Global:__OpsDeckRan = $false
$Global:__OpsDeckOrigPrompt = $function:prompt
$Global:__OpsDeckEsc = [char]0x1b
$Global:__OpsDeckBel = [char]0x07

function Global:prompt {
    $ok = $?
    $code = if ($ok) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    $e = $Global:__OpsDeckEsc; $b = $Global:__OpsDeckBel
    $out = ""
    if ($Global:__OpsDeckRan) { $out += "$e]133;D;$code$b" }
    $Global:__OpsDeckRan = $false
    $cwd = $PWD.ProviderPath -replace '\\', '/'
    if ($cwd -notmatch '^/') { $cwd = "/$cwd" }
    $out += "$e]133;A$b$e]7;file://$($env:COMPUTERNAME)$cwd$b"
    $orig = if ($Global:__OpsDeckOrigPrompt) { & $Global:__OpsDeckOrigPrompt } else { "PS $($PWD.Path)> " }
    $out + $orig + "$e]133;B$b"
}

# the command line is known when Enter is pressed (PSReadLine): report it, then run it
if (Get-Module -Name PSReadLine) {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
        $line = $null; $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        if ($line.Trim()) {
            $Global:__OpsDeckRan = $true
            $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
            [Console]::Write("$($Global:__OpsDeckEsc)]133;E;$b64$($Global:__OpsDeckBel)$($Global:__OpsDeckEsc)]133;C$($Global:__OpsDeckBel)")
        }
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}
