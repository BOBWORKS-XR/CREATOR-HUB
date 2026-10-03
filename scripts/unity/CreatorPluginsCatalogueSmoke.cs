using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

public static class CreatorPluginsCatalogueSmoke
{
    [Serializable] private sealed class Report
    {
        public bool passed, catalogueFresh;
        public string unity, message, error;
        public string[] ids, indexedPaths;
        public int warnings;
    }
    private static CreatorPluginsWindow window;
    private static double deadline;
    private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Read<T>(string name) => (T)typeof(CreatorPluginsWindow).GetField(name, Private).GetValue(window);
    public static void Run()
    {
        if (!File.Exists(Path.Combine(Path.GetDirectoryName(Application.dataPath), ".catalogue-test-fixture")))
            throw new Exception("Refusing a real project.");
        ParsingContracts();
        window = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
        deadline = EditorApplication.timeSinceStartup + 120;
        EditorApplication.update += Tick;
    }
    private static void ParsingContracts()
    {
        const string json = "{\"schemaVersion\":1,\"id\":\"test.listing\",\"version\":\"1.0.0\",\"name\":\"Test\",\"description\":\"Test\",\"author\":{\"name\":\"Test\"},\"license\":\"MIT\",\"licensePath\":\"packages/test/LICENSE.md\",\"instructionsPath\":\"packages/test/README.md\",\"compatibility\":{},\"category\":\"prefab\",\"scope\":\"runtime\",\"reviewStatus\":\"listed\",\"testNotes\":\"Parser fixture\"}";
        string prefix = json.Substring(0, json.Length - 1);
        foreach (string value in new[] { json, prefix + ",\"download\":null}", prefix + ",\"extra\":{\"download\":{}}}" })
        {
            var entry = PluginProtocol.ParseListing(value);
            if (entry.download != null || PluginProtocol.CanImport(entry)) throw new Exception("Absent/null download became importable.");
        }
        foreach (string value in new[] { prefix + ",\"download\":{}}", prefix + ",\"download\":{\"byteLength\":1}}", prefix + ",\"download\":null,\"download\":null}" })
        {
            bool rejected = false;
            try { PluginProtocol.ParseListing(value); } catch { rejected = true; }
            if (!rejected) throw new Exception("Invalid or duplicate download was accepted.");
        }
    }
    private static void Tick()
    {
        var report = new Report { unity = Application.unityVersion };
        try
        {
            report.indexedPaths = Read<string[]>("pendingListings");
            report.message = Read<string>("message");
            bool finished = Read<object>("request") == null && report.indexedPaths != null
                && report.message != "Loading catalogue...";
            if (!finished && EditorApplication.timeSinceStartup < deadline) return;
            report.ids = Read<List<Listing>>("listings").Select(e => e.id).ToArray();
            report.catalogueFresh = Read<bool>("catalogueFresh");
            report.warnings = Read<int>("warnings");
            if (!finished) throw new Exception("Catalogue loading timed out.");
            if (!report.catalogueFresh || report.warnings != 0) throw new Exception("Catalogue is partial or stale.");
            if (report.ids.Length != report.indexedPaths.Length) throw new Exception("Unity did not load every indexed listing.");
            if (!report.ids.Contains("optic.warehouse-loft")) throw new Exception("OptiC's Warehouse Loft is missing.");
            var loft = Read<List<Listing>>("listings").Single(e => e.id == "optic.warehouse-loft");
            if (!PluginProtocol.CanImport(loft)) throw new Exception("The supplemental Loft download is missing or invalid.");
            report.passed = true;
        }
        catch (Exception error) { report.error = error.ToString(); }
        EditorApplication.update -= Tick;
        if (window != null) UnityEngine.Object.DestroyImmediate(window);
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(Application.dataPath), "catalogue-result.json"), JsonUtility.ToJson(report, true));
        EditorApplication.Exit(report.passed ? 0 : 1);
    }
}
