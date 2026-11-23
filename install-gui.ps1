[CmdletBinding()]
param(
    [string[]]$Browser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$installScript = Join-Path $root 'install.ps1'
$knownBrowsers = @('chrome', 'edge', 'brave', 'chromium', 'firefox')

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    [Console]::Error.WriteLine('[X] WinForms tidak tersedia di PowerShell ini; pakai install.ps1 atau node scripts/install-gui.mjs --cli.')
    exit 3
}

if (-not (Test-Path -LiteralPath $installScript)) {
    [Console]::Error.WriteLine("[X] install.ps1 tidak ditemukan di $root")
    exit 3
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'BroAgentAI Installer'
$form.Width = 680
$form.Height = 560
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$header = New-Object System.Windows.Forms.Label
$header.Text = 'BroAgentAI - Native Messaging Host'
$header.Location = New-Object System.Drawing.Point(20, 18)
$header.Size = New-Object System.Drawing.Size(620, 26)
$header.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($header)

$description = New-Object System.Windows.Forms.Label
$description.Text = 'Pilih browser, lalu Install atau Uninstall. Semua registrasi per-user (HKCU), tidak perlu admin.'
$description.Location = New-Object System.Drawing.Point(20, 50)
$description.Size = New-Object System.Drawing.Size(620, 36)
$form.Controls.Add($description)

$browserGroup = New-Object System.Windows.Forms.GroupBox
$browserGroup.Text = 'Browser'
$browserGroup.Location = New-Object System.Drawing.Point(20, 94)
$browserGroup.Size = New-Object System.Drawing.Size(620, 112)
$form.Controls.Add($browserGroup)

$checks = [ordered]@{}
$positions = @(
    @(24, 28), @(24, 58), @(24, 88), @(330, 28), @(330, 58)
)
for ($i = 0; $i -lt $knownBrowsers.Count; $i++) {
    $name = $knownBrowsers[$i]
    $check = New-Object System.Windows.Forms.CheckBox
    $check.Name = $name
    $check.Text = $name
    $check.Location = New-Object System.Drawing.Point([int]$positions[$i][0], [int]$positions[$i][1])
    $check.Size = New-Object System.Drawing.Size(270, 24)
    $check.Checked = ($name -eq 'chrome' -or $name -eq 'edge')
    $browserGroup.Controls.Add($check)
    $checks[$name] = $check
}

if ($Browser) {
    $requested = @($Browser | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
    foreach ($name in $requested) {
        if ($checks.Contains($name)) {
            $checks[$name].Checked = $true
        }
    }
}

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = 'Status: siap'
$statusLabel.Location = New-Object System.Drawing.Point(20, 222)
$statusLabel.Size = New-Object System.Drawing.Size(620, 22)
$form.Controls.Add($statusLabel)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(20, 250)
$progress.Size = New-Object System.Drawing.Size(620, 18)
$progress.Minimum = 0
$progress.Maximum = 100
$progress.Value = 0
$form.Controls.Add($progress)

$output = New-Object System.Windows.Forms.TextBox
$output.Location = New-Object System.Drawing.Point(20, 282)
$output.Size = New-Object System.Drawing.Size(620, 196)
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$output.WordWrap = $true
$output.Text = ''
$form.Controls.Add($output)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = 'Install'
$installButton.Location = New-Object System.Drawing.Point(20, 494)
$installButton.Size = New-Object System.Drawing.Size(130, 32)
$form.Controls.Add($installButton)

$uninstallButton = New-Object System.Windows.Forms.Button
$uninstallButton.Text = 'Uninstall'
$uninstallButton.Location = New-Object System.Drawing.Point(160, 494)
$uninstallButton.Size = New-Object System.Drawing.Size(130, 32)
$form.Controls.Add($uninstallButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = 'Cancel'
$cancelButton.Location = New-Object System.Drawing.Point(510, 494)
$cancelButton.Size = New-Object System.Drawing.Size(130, 32)
$form.Controls.Add($cancelButton)

$script:queue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$script:running = $false
$script:proc = $null

function Append-Output([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return }
    $output.AppendText($Text + [Environment]::NewLine)
    $output.SelectionStart = $output.TextLength
    $output.ScrollToCaret()
}

function Set-Busy([bool]$Busy) {
    $script:running = $Busy
    $installButton.Enabled = -not $Busy
    $uninstallButton.Enabled = -not $Busy
    foreach ($name in $knownBrowsers) { $checks[$name].Enabled = -not $Busy }
    if ($Busy) { $cancelButton.Text = 'Cancel (hentikan)' } else { $cancelButton.Text = 'Cancel' }
    if ($Busy) { $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor } else { $form.Cursor = [System.Windows.Forms.Cursors]::Default }
}

function Get-SelectedBrowsers {
    $selected = @()
    foreach ($name in $knownBrowsers) {
        if ($checks[$name].Checked) { $selected += $name }
    }
    return $selected
}

function Start-Installer([bool]$Uninstall) {
    if ($script:running) { return }
    $browsers = @(Get-SelectedBrowsers)
    if ($browsers.Count -eq 0) {
        [void][System.Windows.Forms.MessageBox]::Show('Pilih minimal satu browser.', 'BroAgentAI', 'OK', 'Warning')
        return
    }

    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $installScript + '"'))
    if ($Uninstall) { $argList += '-Uninstall' }
    $argList += '-Browser'
    $argList += ($browsers -join ',')

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = $argList -join ' '
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    if ($browsers -contains 'firefox' -and $psi.EnvironmentVariables.ContainsKey('BROAGENTAI_EXTENSION_ID')) {
        [void]$psi.EnvironmentVariables.Remove('BROAGENTAI_EXTENSION_ID')
    }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $handler = [System.Diagnostics.DataReceivedEventHandler] {
        param($sender, $e)
        if ($null -ne $e.Data) { $script:queue.Enqueue($e.Data) }
    }
    $proc.add_OutputDataReceived($handler)
    $proc.add_ErrorDataReceived($handler)

    try {
        [void]$proc.Start()
    } catch {
        Append-Output "[X] Gagal menjalankan PowerShell: $($_.Exception.Message)"
        $statusLabel.Text = 'Status: gagal'
        return
    }

    $script:proc = $proc
    Set-Busy $true
    $progress.Value = 0
    $statusLabel.Text = 'Status: installer berjalan...'
    Append-Output ("Menjalankan install.ps1 -Browser {0}" -f ($browsers -join ','))
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.add_Tick({
    $line = $null
    while ($script:queue.TryDequeue([ref]$line)) {
        Append-Output $line
        if ($progress.Value -lt 95) { $progress.Value += 2 }
    }
    if ($script:running -and $null -ne $script:proc -and $script:proc.HasExited) {
        $proc = $script:proc
        $proc.WaitForExit()
        while ($script:queue.TryDequeue([ref]$line)) { Append-Output $line }
        $code = $proc.ExitCode
        $proc.Dispose()
        $script:proc = $null
        Set-Busy $false
        $progress.Value = 100
        $statusLabel.Text = "Status: selesai (exit $code)"
        Append-Output "Selesai dengan exit code $code."
    }
})

$installButton.add_Click({ Start-Installer $false })
$uninstallButton.add_Click({ Start-Installer $true })
$cancelButton.add_Click({
    if ($script:running -and $null -ne $script:proc) {
        $answer = [System.Windows.Forms.MessageBox]::Show('Hentikan installer yang sedang berjalan?', 'BroAgentAI', 'YesNo', 'Question')
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            try { $script:proc.Kill() } catch { }
            Append-Output '[!] Installer dihentikan.'
            $statusLabel.Text = 'Status: dibatalkan'
        }
    } else {
        $form.Close()
    }
})

$timer.Start()
[void]$form.ShowDialog()
$timer.Stop()
if ($null -ne $script:proc) {
    try { $script:proc.Kill() } catch { }
    $script:proc.Dispose()
}
$form.Dispose()
