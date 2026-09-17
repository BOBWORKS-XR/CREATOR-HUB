using System;
using System.IO;
using System.Linq;
using System.Text;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

// Opt-in batch API acceptance, not proof of clicking Unity's import dialog.
[InitializeOnLoad]
public static class CreatorPluginsLargeImportSmoke
{
    private static string Project => Path.GetDirectoryName(Application.dataPath);
    private static bool Fixture => File.Exists(Path.Combine(Project, ".large-package-test-fixture"));
    [Serializable] private sealed class Report { public bool passed; public string error, receipt, sha256, unity; public long byteLength; public int prefabs, scenes; }
    private static UnityWebRequest network;
    private static CreatorPluginsWindow.DiskDownload disk;
    private static double downloadDeadline;
    static CreatorPluginsLargeImportSmoke()
    {
        if (!Fixture) return;
        EditorApplication.update += Poll;
        Application.logMessageReceived += (message, stack, type) => {
            if (type == LogType.Error || type == LogType.Exception) File.AppendAllText(Path.Combine(Project, "import-errors.log"), message + "\n" + stack + "\n");
        };
    }
    public static void Run()
    {
        if (!Fixture) throw new InvalidOperationException("Refusing a real project.");
        try
        {
            var files = Directory.GetFiles(PluginProtocol.Area(Project, "inbox"), "*.json");
            if (files.Length != 1) throw new Exception("Expected one exact desktop queue request.");
            var request = JsonUtility.FromJson<ImportRequest>(File.ReadAllText(files[0]));
            PluginProtocol.ValidateRequest(request, Project);
            if (request.sha256 != "b9a99519a74bdbd5d75d997bed87118896c39a4d712b9ff708e63520ea4fdf94" || request.byteLength != 93_245_650) throw new Exception("Wrong package identity.");
            if (ImportReview.Active != null || ImportReview.RecoveryError != null) throw new Exception("Unexpected active import.");
            using (PluginProtocol.LockPackage(request, Project))
            {
                PluginProtocol.SaveNew(Project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(request)));
                ImportReview.Active = request;
                File.WriteAllText(Path.Combine(Project, "import-started.txt"), DateTime.UtcNow.ToString("O"));
                AssetDatabase.ImportPackage(PluginProtocol.Area(Project, "packages/" + request.packageFile), false);
            }
        }
        catch (Exception error) { Finish(false, error.ToString(), null); }
    }
    public static void Download()
    {
        if (!Fixture || File.Exists(Path.Combine(Project, "large-download-result.json"))) throw new InvalidOperationException("Use a marked disposable fixture without an existing download result.");
        disk = new CreatorPluginsWindow.DiskDownload(93_245_650, "b9a99519a74bdbd5d75d997bed87118896c39a4d712b9ff708e63520ea4fdf94");
        network = new UnityWebRequest("https://cdn.sidequestvr.com/file/4601616/optics-warehouse-loft-unity-urp-ver-6000321f1-prefab.unitypackage", UnityWebRequest.kHttpVerbGET) { downloadHandler = disk, timeout = 180, redirectLimit = 0 };
        downloadDeadline = EditorApplication.timeSinceStartup + 185;
        network.SendWebRequest();
        EditorApplication.update += DownloadTick;
    }
    private static void DownloadTick()
    {
        if (!network.isDone && EditorApplication.timeSinceStartup < downloadDeadline) return;
        string error = null;
        long bytes = 0;
        try
        {
            if (!network.isDone || network.result != UnityWebRequest.Result.Success) throw new Exception(network.error ?? "Download timed out.");
            bytes = disk.Finish().Length;
        }
        catch (Exception failure) { error = failure.ToString(); }
        finally { network.Abort(); network.Dispose(); network = null; disk.Cleanup(); EditorApplication.update -= DownloadTick; }
        if (File.Exists(disk.Temporary)) error = "Temporary download was not removed.";
        var report = new Report { passed = error == null, error = error, receipt = "download-only-no-import", byteLength = bytes, unity = Application.unityVersion,
            sha256 = error == null ? "b9a99519a74bdbd5d75d997bed87118896c39a4d712b9ff708e63520ea4fdf94" : null };
        using (var file = new FileStream(Path.Combine(Project, "large-download-result.json"), FileMode.CreateNew))
        using (var writer = new StreamWriter(file)) writer.Write(JsonUtility.ToJson(report, true));
        EditorApplication.Exit(error == null ? 0 : 1);
    }
    private static void Poll()
    {
        if (!File.Exists(Path.Combine(Project, "import-started.txt")) || File.Exists(Path.Combine(Project, "large-import-result.json"))) return;
        if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
        try
        {
            var file = Directory.GetFiles(PluginProtocol.Area(Project, "inbox"), "*.json").Single();
            var request = JsonUtility.FromJson<ImportRequest>(File.ReadAllText(file));
            var receipt = ImportReview.Receipt(request);
            if (receipt.status == "queued" || receipt.status == "review") return;
            if (receipt.status != "imported") throw new Exception(receipt.message);
            if (ImportReview.Active != null || File.Exists(PluginProtocol.Area(Project, "active-review.json"))) throw new Exception("Import state not released.");
            if (File.ReadAllText(Path.Combine(Project, "Assets/Manual.txt")) != "manually arranged scene") throw new Exception("Sentinel changed.");
            if (File.Exists(Path.Combine(Project, "import-errors.log"))) throw new Exception("Unity emitted errors; inspect import-errors.log.");
            if (AssetDatabase.FindAssets("t:Scene", new[] {"Assets"}).Length == 0) throw new Exception("No imported scene.");
            Finish(true, null, request);
        }
        catch (Exception error) { Finish(false, error.ToString(), null); }
    }
    private static void Finish(bool passed, string error, ImportRequest request)
    {
        var report = new Report { passed = passed, error = error, receipt = passed ? "imported" : "unconfirmed", sha256 = request?.sha256, byteLength = request?.byteLength ?? 0, unity = Application.unityVersion,
            prefabs = AssetDatabase.FindAssets("t:Prefab", new[] {"Assets"}).Length, scenes = AssetDatabase.FindAssets("t:Scene", new[] {"Assets"}).Length };
        File.WriteAllText(Path.Combine(Project, "large-import-result.json"), JsonUtility.ToJson(report, true));
        EditorApplication.Exit(passed ? 0 : 1);
    }
}
