using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

public static class CreatorPluginsImportSmoke
{
    [Serializable] private sealed class Report { public bool passed; public string unity, error; public string[] checks; }
    private const string Asset = "Assets/PluginsReleaseProbe.txt";
    private const string Content = "Harmless Creator Plugins release import fixture";
    private static readonly List<string> Checks = new List<string>();
    private static string project, filename;
    private static Listing entry;
    private static ImportRequest request;
    private static int phase;
    private static double deadline;
    private static readonly BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;

    public static void Run()
    {
        project = Path.GetDirectoryName(Application.dataPath);
        if (!File.Exists(Path.Combine(project, ".import-test-fixture"))) throw new Exception("Refusing a real project.");
        try
        {
            File.WriteAllText(Path.Combine(project, Asset), Content);
            AssetDatabase.ImportAsset(Asset, ImportAssetOptions.ForceSynchronousImport);
            string archive = Path.Combine(project, "probe.unitypackage");
            AssetDatabase.ExportPackage(Asset, archive, ExportPackageOptions.Default);
            if (!AssetDatabase.DeleteAsset(Asset)) throw new Exception("Could not remove fixture source before import.");
            byte[] bytes = File.ReadAllBytes(archive);
            entry = PluginProtocol.ParseListing(File.ReadAllText(Path.Combine(project, "listing.json")));
            entry.reviewStatus = "listed";
            entry.download.byteLength = bytes.Length;
            using (var stream = new MemoryStream(bytes)) entry.download.sha256 = PluginProtocol.Hash(stream);
            filename = entry.download.sha256 + ".unitypackage";
            PluginProtocol.SaveNew(project, "packages/" + filename, bytes);
            request = CreatorPluginsWindow.QueueImport(entry, filename);
            ImportReview.Review(request);
            Checks.Add("Real archive queued and native Unity import review opened");
            deadline = EditorApplication.timeSinceStartup + 90;
            EditorApplication.update += Tick;
        }
        catch (Exception error) { Finish(error); }
    }

    private static object Wizard(EditorWindow window)
    {
        Type type = window.GetType().Assembly.GetType("UnityEditor.PackageImportWizard", true);
        return type.GetProperty("instance", Flags).GetValue(null, null);
    }

    private static void InvokeWizard(object wizard, string method, params object[] args)
    {
        try { wizard.GetType().GetMethod(method, Flags).Invoke(wizard, args); }
        // Unity ends the GUI event after closing the native import window.
        catch (TargetInvocationException error) when (error.InnerException is ExitGUIException) { }
    }

    private static void Tick()
    {
        try
        {
            if (EditorApplication.timeSinceStartup > deadline) throw new Exception("Native import fixture exceeded deadline, phase " + phase);
            var window = Resources.FindObjectsOfTypeAll<EditorWindow>().FirstOrDefault(value => value.GetType().FullName == "UnityEditor.PackageImport");
            if (phase == 0 && window != null)
            {
                object wizard = Wizard(window);
                phase = 1;
                InvokeWizard(wizard, "CancelImport");
            }
            else if (phase == 1 && ImportReview.Active == null)
            {
                if (ImportReview.Receipt(request).status != "cancelled" || File.Exists(Path.Combine(project, Asset))) throw new Exception("Native cancellation did not preserve an unimported fixture.");
                Checks.Add("Native dialog cancellation produced a durable cancelled receipt without importing");
                request = CreatorPluginsWindow.QueueImport(entry, filename);
                ImportReview.Review(request);
                phase = 2;
            }
            else if (phase == 2 && window != null)
            {
                var items = window.GetType().GetField("m_ImportPackageItems", Flags).GetValue(window);
                if (items == null) return;
                object wizard = Wizard(window);
                phase = 3;
#if UNITY_6000_0_OR_NEWER
                InvokeWizard(wizard, "DoImportStep", items);
#else
                InvokeWizard(wizard, "DoNextStep", items);
#endif
            }
            else if (phase == 3 && ImportReview.Active == null && !ImportReview.EditorBusy)
            {
                if (ImportReview.Receipt(request).status != "imported" || File.ReadAllText(Path.Combine(project, Asset)) != Content) throw new Exception("Real archive import or its terminal receipt failed.");
                Checks.Add("Retry used the real native import path and restored the exact asset bytes");
                if (Directory.GetFiles(Application.dataPath, "*.unity", SearchOption.AllDirectories).Length != 0) throw new Exception("Unexpected scene save in disposable import fixture.");
                Checks.Add("No scene was saved");
                Finish(null);
            }
        }
        catch (Exception error) { Finish(error); }
    }

    private static void Finish(Exception error)
    {
        EditorApplication.update -= Tick;
        var report = new Report { passed = error == null, unity = Application.unityVersion, error = error == null ? null : error.ToString(), checks = Checks.ToArray() };
        File.WriteAllText(Path.Combine(project, "import-result.json"), JsonUtility.ToJson(report, true));
        if (error != null) Debug.LogException(error);
        EditorApplication.Exit(report.passed ? 0 : 1);
    }
}
