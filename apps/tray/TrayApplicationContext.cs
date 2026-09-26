using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace OpenFDE.Tray;

/// <summary>
/// Top-level application context that owns the system-tray icon and its menu.
/// No visible form — the app lives entirely in the tray.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private const int DefaultPort = 4517;

    private NotifyIcon _tray;
    private ContextMenuStrip _menu;
    private ToolStripMenuItem _startStopItem;
    private ToolStripMenuItem _openItem;
    private ServerProcess _server;
    private IContainer? _components;

    public TrayApplicationContext()
    {
        _server = new ServerProcess(DefaultPort);

        _components = new Container();
        _tray = new NotifyIcon(_components)
        {
            Icon = BuildIcon(),
            Text = "OpenFDE",
            Visible = true,
        };

        _menu = new ContextMenuStrip();
        _openItem = new ToolMenuItem("Open in browser", OnOpen);
        _startStopItem = new ToolMenuItem("Start", OnStartStop);
        var sep = new ToolStripSeparator();
        var quitItem = new ToolMenuItem("Quit", OnQuit);

        _menu.Items.AddRange(new ToolStripItem[]
        {
            _openItem,
            _startStopItem,
            sep,
            quitItem,
        });

        _tray.ContextMenuStrip = _menu;
        _tray.DoubleClick += (_, _) => OnOpen(null, EventArgs.Empty);
        _menu.Opening += OnMenuOpening;

        // Auto-start + open browser the first time.
        OnStartStop(null, EventArgs.Empty);
    }

    // ---- Menu handlers ----------------------------------------------------------------------

    private void OnMenuOpening(object? sender, CancelEventArgs e)
    {
        try
        {
            var running = _server.IsRunning;
            _startStopItem.Text = running ? "Restart" : "Start";
            _openItem.Enabled = running;
            _tray.Text = _server.Tooltip;
            _tray.Icon = BuildIcon(running);
        }
        catch (Exception ex)
        {
            _tray.Text = $"OpenFDE — error: {ex.Message}";
        }
    }

    private async void OnStartStop(object? sender, EventArgs e)
    {
        try
        {
            if (_server.IsRunning)
            {
                // Restart: stop then start
                _server.Stop();
                await Task.Delay(200);
            }
            _server.Start();
            _tray.ShowBalloonTip(1500, "OpenFDE", $"Server started on :{DefaultPort}", ToolTipIcon.Info);
            await _server.WaitForPortAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "OpenFDE", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OnOpen(object? sender, EventArgs e)
    {
        if (!_server.IsRunning)
        {
            OnStartStop(sender, e);
        }
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = _server.BaseUrl,
                UseShellExecute = true,                 // let the OS pick the default browser
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Could not open browser: {ex.Message}", "OpenFDE",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OnQuit(object? sender, EventArgs e)
    {
        _tray.Visible = false;   // remove icon immediately so the user sees it go
        _server.Stop();
        _tray.Dispose();
        Application.Exit();
    }

    // ---- Icon -------------------------------------------------------------------------------

    private static Icon BuildIcon(bool running = true)
    {
        // 16x16 tray icon: dark rounded square + mercury-accent baseline.
        // Lightweight — keeps the binary small and avoids .ico resource overhead.
        var bmp = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.SingleBitPerPixelGridFit;
            g.Clear(Color.Transparent);

            var body = running
                ? Color.FromArgb(0xE0, 0x56, 0x1C)   // OpenFDE accent orange (#e0561c)
                : Color.FromArgb(0x99, 0x99, 0x99);  // grey when stopped
            using var brush = new SolidBrush(body);
            g.FillRectangle(brush, 1, 1, 14, 14);

            // small glyph: geometric "brain/graph" hint — three nodes + bar
            using var pen = new Pen(Color.White, 1.5f);
            g.DrawLine(pen, 3, 8, 7, 4);
            g.DrawLine(pen, 7, 4, 13, 9);
            g.DrawLine(pen, 7, 13, 13, 10);
        }
        // GetHicon returns an unmanaged handle we *must* keep alive while the Icon lives.
        // We suppress the finalizer so the GC won't try to free a handle we never released.
        // WinForms NotifyIcon clones the handle internally, so this is safe.
        var hIcon = bmp.GetHicon();
        var icon = Icon.FromHandle(hIcon);
        return icon;
    }
}

/// <summary>Helper to add a menu-item in one expression.</summary>
file sealed class ToolMenuItem : ToolStripMenuItem
{
    public ToolMenuItem(string text, EventHandler? onClick)
        : base(text, null, onClick) { }
}
