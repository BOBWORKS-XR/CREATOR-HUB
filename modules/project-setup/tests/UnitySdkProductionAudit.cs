using System;
using System.IO;
using System.Linq;
using System.Text;
using BS.SDKEditor;
using BS.SDKEditor.Setup;
using Unity.VisualScripting;
using UnityEditor;
using UnityEngine;

// Disposable production-flow audit. Never installed into a user's project.
public static class UnitySdkProductionAudit
{
    private const string Target = "E:/UnityTest/CreatorSetupSdk4022Vs1912-Production-20261026";
    private const string StampKey = "BS.SDK.VisualScriptingNodes";
    private static void RequireFixture()
    {
        var root = Directory.GetParent(Application.dataPath).FullName.Replace('\\', '/');
        if (!Application.isBatchMode || !string.Equals(root, Target, StringComparison.OrdinalIgnoreCase)
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_AUDIT") != Target
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_EDITORS_CLOSED") != "yes"
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_VS38_PREF_BACKUP_APPROVED") != "yes")
            throw new InvalidOperationException("Unreviewed production audit fixture.");
#if GREENFIELD_PROJECT
        throw new InvalidOperationException("Ordinary SDK startup is required.");
#endif
        if (Application.unityVersion != "6000.3.21f1"
            || UnityEditor.PackageManager.PackageInfo.FindForPackageName("com.sidequest.creator-sdk")?.version != "4.0.22"
            || UnityEditor.PackageManager.PackageInfo.FindForPackageName("com.unity.visualscripting")?.version != "1.9.12")
            throw new InvalidOperationException("The exact qualified package pair is required.");
    }

    private static void RequireReady()
    {
        RequireFixture();
        var config = BoltCore.Configuration;
        var check = ProjectSetup.Checks.Single(item => item.Id == "sdk.visual-scripting");
        if (ProjectSetup.Evaluate(check).State != SetupState.Done || !VsNodeGeneration.NodesBuiltForThisVersion
            || !VsNodeGeneration.NodeDatabaseExists
            || !config.typeOptions.Contains(typeof(StringBuilder))
            || !config.typeOptions.Contains(typeof(System.Xml.Linq.XDocument))
            || !config.assemblyOptions.Contains(new LooseAssemblyName(typeof(System.Xml.Linq.XDocument).Assembly.GetName().Name)))
            throw new InvalidOperationException("SDK readiness or retained custom selections did not survive reopening.");
    }

    private static void Receipt(string name, string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        var path = Path.Combine(Target, ".creator-project-setup", name);
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
        if (!File.ReadAllBytes(path).SequenceEqual(bytes))
            throw new InvalidOperationException("Audit evidence readback failed.");
    }

    public static void PrepareRepeatRepair()
    {
        try {
            RequireReady();
            var stamp = EditorUserSettings.GetConfigValue(StampKey);
            if (string.IsNullOrEmpty(stamp)) throw new InvalidOperationException("Missing SDK-authored stamp.");
            Receipt("repeat-stamp-before.txt", stamp);
            // Simulate a lost stamp on this disposable copy only, through Unity's API.
            EditorUserSettings.SetConfigValue(StampKey, null);
            if (VsNodeGeneration.NodesBuiltForThisVersion)
                throw new InvalidOperationException("Repeat-repair preparation did not invalidate the stamp.");
            Receipt("repeat-prepared.json", "{\"prepared\":true,\"releaseAcceptance\":false}");
            EditorApplication.Exit(0);
        } catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(2); }
    }

    public static void VerifyReopened()
    {
        try {
            RequireReady();
            Receipt("production-reopened.json", "{\"sdkReadyDone\":true,\"customSelectionsPreserved\":true,\"releaseAcceptance\":false}");
            EditorApplication.Exit(0);
        } catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(2); }
    }
}
