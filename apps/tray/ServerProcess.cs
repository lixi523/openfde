using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace OpenFDE.Tray;

/// <summary>
/// Manages a long-running <c>openfde serve</c> child process.
/// Resolves the CLI from the tray's own directory, a sibling "cli\" folder,
/// or the system <c>PATH</c>.
/// </summary>
internal sealed class ServerProcess : IDisposable
{
    private Process? _process;
    private readonly int _port;
    private readonly string _tooltip;
    private static readonly object _lock = new();

    public ServerProcess(int port = 4517)
    {
        _port = port;
        _tooltip = $"OpenFDE — port {port}";
    }

    public bool IsRunning
    {
        get
        {
            lock (_lock)
            {
                return _process is { HasExited: false };
            }
        }
    }

    public string BaseUrl => $"http://127.0.0.1:{_port}/";

    public string Tooltip => IsRunning ? $"{_tooltip} (running)" : $"{_tooltip} (stopped)";

    public void Start()
    {
        lock (_lock)
        {
            if (IsRunning) return;

            var path = LocateOpenFde();
            if (path is null)
            {
                throw new FileNotFoundException(
                    "Could not find the OpenFDE CLI. Install it via `npm i -g openfde-cli` " +
                    "or place the built `openfde.exe` next to OpenFDE.Tray.exe.");
            }

            // Whether `path` is a .exe or a script, run it with `serve`.
            // The CLI supports `openfde serve --port <n>` so we just pass args.
            var startInfo = new ProcessStartInfo
            {
                FileName = path,
                Arguments = $"serve --port {_port}",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(path) ?? AppContext.BaseDirectory,
            };

            var proc = new Process { StartInfo = startInfo, EnableRaisingEvents = true };

            // Capture / drain output so the child doesn't block on a full pipe.
            proc.OutputDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                    Trace.WriteLine($"[openfde] {e.Data}");
            };
            proc.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                    Trace.WriteLine($"[openfde:err] {e.Data}");
            };

            proc.Exited += (_, _) =>
            {
                Trace.WriteLine("[openfde] child exited.");
                lock (_lock) { _process = null; }
            };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            _process = proc;
        }
    }

    /// <summary>Fire-and-forget wait for the listening port. Useful for auto-opening the browser.</summary>
    public async Task WaitForPortAsync(CancellationToken ct = default)
    {
        // give the child a moment to bind, then poll.
        for (int i = 0; i < 50; i++)
        {
            if (ct.IsCancellationRequested) return;
            if (IsPortOpen("127.0.0.1", _port)) return;
            await Task.Delay(100, ct);
        }
    }

    public void Stop()
    {
        lock (_lock)
        {
            if (_process is null || _process.HasExited) return;
            try
            {
                // Try graceful close first (Ctrl-C via CloseMainWindow), then kill.
                if (_process.CloseMainWindow())
                {
                    if (!_process.WaitForExit(5000))
                        _process.Kill(entireProcessTree: true);
                }
                else
                {
                    _process.Kill(entireProcessTree: true);
                    _process.WaitForExit(5000);
                }
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"[tray] stop failed: {ex.Message}");
            }
            finally
            {
                _process.Dispose();
                _process = null;
            }
        }
    }

    public void Dispose() => Stop();

    // ---- CLI resolution --------------------------------------------------------------------

    private static string? LocateOpenFde()
    {
        var exeName = "openfde.exe";
        var cmdName = OpenFdeCliCommand();  // e.g. "openfde.cmd" on windows we look for .exe first

        // 1) next to the tray exe (portable layout: apps/cli/dist + apps/tray)
        var local = AppContext.BaseDirectory;
        foreach (var name in new[] { exeName, cmdName })
        {
            var candidate = Path.Combine(local, name);
            if (File.Exists(candidate)) return candidate;
        }

        // 2) sibling "cli\dist" (dev layout)
        var cliSibling = Path.Combine(local, "..", "cli", "dist", "index.exe");
        if (File.Exists(cliSibling)) return Path.GetFullPath(cliSibling);

        // 3) sibling "server" folder (published OpenFDE.Server self-contained)
        foreach (var name in new[] { exeName, "openfde" })
        {
            var candidate = Path.Combine(local, "server", name);
            if (File.Exists(candidate)) return candidate;
        }

        // 4) system PATH
        var pathVar = Environment.GetEnvironmentVariable("PATH");
        if (pathVar is not null)
        {
            foreach (var dir in pathVar.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                foreach (var name in new[] { exeName, cmdName })
                {
                    var candidate = Path.Combine(dir, name);
                    if (File.Exists(candidate)) return candidate;
                }
            }
        }

        // 5) `openfde` on PATH as a generic command (Linux/macOS fallback, won't hurt on Windows)
        return null;
    }

    /// <summary>
    /// The file name used to invoke the CLI when it's on PATH.
    /// On Windows npm global installs produce a `.cmd` shim.
    /// </summary>
    private static string OpenFdeCliCommand() => "openfde.cmd";

    private static bool IsPortOpen(string host, int port)
    {
        try
        {
            using var client = new System.Net.Sockets.TcpClient();
            var result = client.BeginConnect(host, port, null, null);
            var success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(200));
            if (!success) return false;
            client.EndConnect(result);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
