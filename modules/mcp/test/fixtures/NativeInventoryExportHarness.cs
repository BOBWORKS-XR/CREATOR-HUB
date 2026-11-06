using System;
using System.IO;
using System.Reflection;
using System.Text.Json;
using CreatorWorks.Diagnostics;

public static class NativeInventoryExportHarness
{
    // Uses real filesystem operations and a Unity API double; never opens Unity.
    public static void Run(string[] args)
    {
        var helper = new CreatorNativeInventory();
        typeof(CreatorNativeInventory).GetMethod("Awake", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(helper, null);
        var scene = new UnityEngine.SceneManagement.Scene();
        scene.roots.Add(new UnityEngine.GameObject(42));
        UnityEngine.SceneManagement.SceneManager.scenes.Add(scene);
        string error;
        FileStream receiptLock = null;
        bool denied = !helper.TryApproveExport(args[0], args[1], false, 60, out error);
        Console.WriteLine("DENIED:" + denied.ToString().ToLowerInvariant());
        while (true)
        {
            string command = Console.ReadLine();
            if (command == null || command == "quit") break;
            if (command == "approve")
            {
                bool ok = helper.TryApproveExport(args[0], args[1], true, 60, out error);
                Console.WriteLine("RESULT:" + JsonSerializer.Serialize(new { ok, error, sessionId = helper.SessionId, directory = helper.ExportDirectory }));
            }
            else if (command == "publish")
            {
                bool ok = helper.TryCaptureAndPublish(100, 64, 50, out error);
                Console.WriteLine("RESULT:" + JsonSerializer.Serialize(new { ok, error }));
            }
            else if (command == "revoke")
            {
                bool ok = helper.TryRevoke(out error);
                Console.WriteLine("RESULT:" + JsonSerializer.Serialize(new { ok, error, sessionId = helper.SessionId }));
            }
            else if (command == "disable")
            {
                typeof(CreatorNativeInventory).GetMethod("OnDisable", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(helper, null);
                Console.WriteLine("RESULT:" + JsonSerializer.Serialize(new { ok = helper.SessionId == null, error = helper.LastCleanupError }));
            }
            else if (command == "lock-receipt")
            {
                receiptLock = new FileStream(Path.Combine(helper.ExportDirectory, "session.json"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                Console.WriteLine("RESULT:" + JsonSerializer.Serialize(new { ok = true }));
            }
            else if (command == "unlock-receipt")
            {
                receiptLock.Dispose(); receiptLock = null;
                Console.WriteLine("RESULT:" + JsonSerializer.Serialize(new { ok = true }));
            }
            else throw new Exception("Unknown fixture command");
            Console.Out.Flush();
        }
        receiptLock?.Dispose(); helper.Revoke();
    }
}
