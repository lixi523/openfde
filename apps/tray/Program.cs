using System;
using System.Threading;
using System.Windows.Forms;

namespace OpenFDE.Tray;

static class Program
{
    [STAThread]
    static void Main()
    {
        // Prevent multiple instances
        using var mutex = new Mutex(true, "OpenFDE.Tray", out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show(
                "OpenFDE is already running in the system tray.",
                "OpenFDE",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext());

        GC.KeepAlive(mutex);
    }
}
