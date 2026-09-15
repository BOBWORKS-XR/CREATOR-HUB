using System;
using System.IO;
using System.Linq;
using System.Reflection;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
public static class CreatorPluginsPresentationInteractive
{
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    private static string Project => Path.GetDirectoryName(Application.dataPath);
    private static bool IsFixture => File.Exists(Path.Combine(Project, ".presentation-ui-fixture"));
    [Serializable] private sealed class Result { public bool passed; public string[] statuses; public bool textMatches, noActiveImport; }
    static CreatorPluginsPresentationInteractive()
    {
        if (!IsFixture) return;
        AssetDatabase.importPackageCancelled += name => EditorApplication.delayCall += Verify;
        AssetDatabase.importPackageCompleted += name => EditorApplication.delayCall += Verify;
        EditorApplication.update += () => { if (File.Exists(Path.Combine(Project, ".finish-ui-test"))) EditorApplication.Exit(0); };
    }
    public static void Open()
    {
        if (!IsFixture || File.Exists(Path.Combine(Project, "fixture.unitypackage"))) throw new Exception("Refusing a real or reused project.");
        const string asset = "Assets/PluginCardImportTest.txt";
        File.WriteAllText(Path.Combine(Project, asset), "Creator Plugins cancel and retry fixture.\n");
        AssetDatabase.ImportAsset(asset, ImportAssetOptions.ForceSynchronousImport);
        string package = Path.Combine(Project, "fixture.unitypackage");
        AssetDatabase.ExportPackage(asset, package, ExportPackageOptions.Default);
        if (!AssetDatabase.DeleteAsset(asset)) throw new Exception("Could not clean generated export asset.");
        var entry = JsonUtility.FromJson<Listing>(File.ReadAllText(Path.Combine(Project, "listing.json")));
        entry.id = "fixture.presentation"; entry.name = "Start Location (UI test)";
        entry.reviewStatus = "listed"; entry.includesCode = false;
        entry.usage = "Disposable test: imports only PluginCardImportTest.txt, not Egon's package.";
        entry.contents = new[] { asset };
        byte[] bytes = File.ReadAllBytes(package);
        using (var stream = new MemoryStream(bytes)) entry.download.sha256 = PluginProtocol.Hash(stream);
        entry.download.byteLength = bytes.Length;
        PluginProtocol.SaveNew(Project, "packages/" + entry.download.sha256 + ".unitypackage", bytes);
        var window = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
        window.titleContent = new GUIContent("Plugins UI Test");
        window.minSize = new Vector2(360, 360);
        ((System.Collections.Generic.List<Listing>)typeof(CreatorPluginsWindow).GetField("listings", Private).GetValue(window)).Add(entry);
        typeof(CreatorPluginsWindow).GetField("catalogueFresh", Private).SetValue(window, true);
        typeof(CreatorPluginsWindow).GetField("catalogueLoadedAt", Private).SetValue(window, EditorApplication.timeSinceStartup);
        window.ShowUtility(); window.position = new Rect(80, 100, 420, 560); window.Focus();
        File.WriteAllText(Path.Combine(Project, "ui-ready.json"), JsonUtility.ToJson(entry, true));
    }
    private static void Verify()
    {
        var history = PluginProtocol.Area(Project, "history/requests");
        var files = Directory.GetFiles(PluginProtocol.Area(Project, "inbox"), "*.json").Concat(Directory.Exists(history) ? Directory.GetFiles(history, "*.json") : Array.Empty<string>());
        var requests = files.Select(ImportReview.Read<ImportRequest>).ToArray();
        string[] statuses = requests.Select(value => ImportReview.Receipt(value).status).OrderBy(value => value).ToArray();
        string asset = Path.Combine(Project, "Assets/PluginCardImportTest.txt");
        var result = new Result { statuses = statuses, textMatches = File.Exists(asset) && File.ReadAllText(asset) == "Creator Plugins cancel and retry fixture.\n", noActiveImport = ImportReview.Active == null };
        result.passed = statuses.SequenceEqual(new[] { "cancelled", "imported" }) && result.textMatches && result.noActiveImport;
        File.WriteAllText(Path.Combine(Project, "interactive-result.json"), JsonUtility.ToJson(result, true));
    }
}
