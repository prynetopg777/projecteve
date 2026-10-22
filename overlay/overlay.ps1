# Eve's desktop indicator: a small always-on-top pill in the bottom-right corner.
# Polls the local server for status. Drag to move, double-click to open Eve, right-click for options.
# Exits by itself when the launcher process (ParentPid) is gone.
param([int]$Port = 7777, [int]$ParentPid = 0, [string]$Browser = 'msedge')

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class EveWin {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
}
"@

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True"
        ShowInTaskbar="False" ShowActivated="False" ResizeMode="NoResize" SizeToContent="WidthAndHeight">
  <Border Name="Pill" CornerRadius="12" Background="#D90A1220" BorderBrush="#334FD8FF" BorderThickness="1" Padding="9,4,11,4" Cursor="Hand">
    <StackPanel Orientation="Horizontal">
      <Ellipse Name="Dot" Width="8" Height="8" Fill="#4FD8FF" VerticalAlignment="Center">
        <Ellipse.Effect><DropShadowEffect Color="#4FD8FF" BlurRadius="10" ShadowDepth="0" Opacity="0.9"/></Ellipse.Effect>
      </Ellipse>
      <TextBlock Name="Label" Text="EVE" Foreground="#D6ECF7" FontFamily="Segoe UI Semibold" FontSize="11" Margin="7,0,0,1" VerticalAlignment="Center"/>
    </StackPanel>
  </Border>
</Window>
"@
$win   = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$pill  = $win.FindName('Pill')
$dot   = $win.FindName('Dot')
$label = $win.FindName('Label')
$glow  = $dot.Effect

$base = "http://127.0.0.1:$Port"
# state -> color, label, pulse speed (0 = steady), idle-ish opacity
$styles = @{
  idle       = @('#4FD8FF', 'EVE',            0.05, 0.55)
  listening  = @('#4FD8FF', 'Listening',      0.30, 1.0)
  thinking   = @('#FFB547', 'Thinking',       0.18, 1.0)
  speaking   = @('#C792FF', 'Speaking',       0.35, 1.0)
  permission = @('#FFB547', 'Needs your OK',  0.45, 1.0)
  offline    = @('#6F8EA3', 'Offline',        0.0,  0.5)
}
$script:state = 'offline'; $script:status = $null; $script:phase = 0.0
$script:task = $null; $script:anchorRight = $null; $script:anchorBottom = $null

function Open-Eve {
  # The server opens Eve's app window (same Edge/Chrome profile as at startup); browser tab if that fails.
  if (Post-Eve '/api/open-window') { return }
  try { if ($Browser) { Start-Process $Browser "http://localhost:$Port" } else { Start-Process "http://localhost:$Port" } }
  catch { Start-Process "http://localhost:$Port" }
}
function Post-Eve($route, $body = '{}') {
  try { $wc = New-Object System.Net.WebClient; $wc.Headers.Add('Content-Type', 'application/json'); [void]$wc.UploadString("$base$route", 'POST', $body); return $true } catch { return $false }
}

function Apply-State {
  $s = $script:status
  $key = $script:state
  $st = $styles[$key]
  $color = [Windows.Media.ColorConverter]::ConvertFromString($st[0])
  $dot.Fill = New-Object Windows.Media.SolidColorBrush $color
  $glow.Color = $color
  $text = $st[1]
  if ($key -eq 'idle' -and $s -and $s.clients -eq 0) { $text = 'EVE - window closed' }
  if ($key -eq 'idle' -and $s -and $s.auto) { $text = $text + ' - AUTO' }
  if ($s -and $s.reminder) { $text = 'Reminder: ' + $(if ($s.reminder.Length -gt 32) { $s.reminder.Substring(0, 32) + '...' } else { $s.reminder }) }
  $label.Text = $text
  $win.Opacity = $st[3]
  $model = if ($s) { $s.model } else { '?' }
  $auto = if ($s -and $s.auto) { ', auto mode ON' } else { '' }
  $pill.ToolTip = "Eve - $key (model: $model$auto)`nDouble-click to open, drag to move, right-click for options"
}

# Keep the pill anchored to its bottom-right corner as its width changes.
$win.Add_SizeChanged({
  if ($script:anchorRight -ne $null) { $win.Left = $script:anchorRight - $win.ActualWidth; $win.Top = $script:anchorBottom - $win.ActualHeight }
})
$win.Add_Loaded({
  $wa = [System.Windows.SystemParameters]::WorkArea
  $script:anchorRight = $wa.Right - 16; $script:anchorBottom = $wa.Bottom - 16
  $win.Left = $script:anchorRight - $win.ActualWidth; $win.Top = $script:anchorBottom - $win.ActualHeight
  Apply-State
})
# Tool window (no Alt+Tab entry) that never steals focus.
$win.Add_SourceInitialized({
  $h = (New-Object System.Windows.Interop.WindowInteropHelper $win).Handle
  [void][EveWin]::SetWindowLong($h, -20, ([EveWin]::GetWindowLong($h, -20) -bor 0x80 -bor 0x08000000))
})

$pill.Add_MouseLeftButtonDown({
  param($sender, $e)
  if ($e.ClickCount -ge 2) { Open-Eve; return }
  try { $win.DragMove() } catch {}
  $script:anchorRight = $win.Left + $win.ActualWidth; $script:anchorBottom = $win.Top + $win.ActualHeight
})

$menu = New-Object System.Windows.Controls.ContextMenu
foreach ($item in @(@('Open Eve', { Open-Eve }), @('Toggle auto mode', { [void](Post-Eve '/api/auto' $(if ($script:status.auto) { '{"on":false}' } else { '{"on":true}' })) }), @('Hide indicator', { $win.Close() }), @('Quit Eve', { Post-Eve '/api/quit' }))) {
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Header = $item[0]; $mi.Add_Click($item[1]); [void]$menu.Items.Add($mi)
}
$pill.ContextMenu = $menu

# Animation: breathe the dot at a speed that depends on the state.
$anim = New-Object System.Windows.Threading.DispatcherTimer
$anim.Interval = [TimeSpan]::FromMilliseconds(40)
$anim.Add_Tick({
  $speed = $styles[$script:state][2]
  if ($speed -eq 0) { $dot.Opacity = 0.8; return }
  $script:phase += $speed
  $dot.Opacity = 0.55 + 0.45 * [Math]::Sin($script:phase)
})
$anim.Start()

# Poll status without blocking the UI thread (a refused connection can take ~1s on Windows).
$poll = New-Object System.Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromMilliseconds(400)
$script:ticks = 0
$poll.Add_Tick({
  $script:ticks++
  if ($ParentPid -and ($script:ticks % 5 -eq 0)) {
    try { [void][System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $win.Close(); return }
  }
  if ($script:task -eq $null) {
    $script:task = (New-Object System.Net.WebClient).DownloadStringTaskAsync("$base/api/status")
    return
  }
  if (-not $script:task.IsCompleted) { return }
  $prev = "$($script:state)|$($script:status.clients)|$($script:status.reminder)|$($script:status.model)|$($script:status.auto)"
  if ($script:task.Status -eq 'RanToCompletion') {
    $script:status = $script:task.Result | ConvertFrom-Json
    $script:state = $script:status.state
  } else {
    $script:status = $null; $script:state = 'offline'
  }
  $script:task = $null
  if ("$($script:state)|$($script:status.clients)|$($script:status.reminder)|$($script:status.model)|$($script:status.auto)" -ne $prev) { Apply-State }
})
$poll.Start()

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnMainWindowClose'
[void]$app.Run($win)
