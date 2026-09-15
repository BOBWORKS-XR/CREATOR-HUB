using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Diagnostic only: each run creates a fresh owned directory and preserves its evidence.
public static class ReceiptReplacementProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ReplaceFileW(string destination, string source, string backup, uint flags, IntPtr exclude, IntPtr reserved);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);

    public static string Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "creator-receipt-probe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var log = new StringBuilder("Diagnostic only; no existing receipt or project was touched.\n");
        foreach (var mode in new[] { "replace0", "replace1", "move1", "dotnet" })
        {
            var folder = Path.Combine(root, mode);
            Directory.CreateDirectory(folder);
            var destination = Path.Combine(folder, "receipt.json");
            File.WriteAllText(destination, "initial");
            int completed = 0;
            for (int n = 0; n < 1000; n++)
            {
                var source = Path.Combine(folder, "source-" + n + ".json");
                var payload = Encoding.UTF8.GetBytes("receipt-" + n);
                using (var stream = new FileStream(source, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { stream.Write(payload, 0, payload.Length); stream.Flush(true); }
                // Match receipt inspection before replacing; the read handle is disposed.
                using (var stream = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read))
                { if (stream.Length == 0) throw new IOException("Unexpected empty receipt"); }
                bool result = false;
                int error = 0;
                string exception = "";
                if (mode == "dotnet")
                {
                    try { File.Replace(source, destination, null); result = true; }
                    catch (IOException ex) { error = ex.HResult; exception = ex.Message; }
                }
                else
                {
                    result = mode == "move1" ? MoveFileExW(source, destination, 1)
                        : ReplaceFileW(destination, source, null, mode == "replace1" ? 1u : 0u, IntPtr.Zero, IntPtr.Zero);
                    if (!result) error = Marshal.GetLastWin32Error();
                }
                if (!result)
                {
                    log.AppendLine(mode + " failed iteration=" + n + " error=" + error + " message=" + exception
                        + " sourceExists=" + File.Exists(source) + " destinationExists=" + File.Exists(destination));
                    break;
                }
                if (File.ReadAllText(destination) != "receipt-" + n) throw new IOException("Readback mismatch");
                completed++;
            }
            log.AppendLine(mode + " completed=" + completed);
        }
        File.WriteAllText(Path.Combine(root, "result.txt"), log.ToString());
        return root + "\n" + log;
    }
}
