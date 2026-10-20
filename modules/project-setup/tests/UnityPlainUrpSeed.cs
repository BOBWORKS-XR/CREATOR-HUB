using System;
using System.IO;
using System.Linq;
using System.Text;
using Unity.VisualScripting;
using Unity.VisualScripting.Dependencies.Sqlite;
using UnityEditor;
using UnityEngine;

// Opt-in acceptance fixture only. No Creator SDK types or preference writes.
public static class UnityPlainUrpSeed
{
    private const string Target = "E:/UnityTest/CreatorSetupSdkAddOrdinary-20261019";
    private const string ExpectedEditor = "@@EDITOR_VERSION@@";
    private static string ExpectedBefore => Environment.GetEnvironmentVariable("CREATOR_SETUP_REAL_SDK_CACHE_EXPECTED_BEFORE");
    private const string SdkPreference = "Banter_GeneratedVSNodesVersion";
    private static string StatusFolder => Path.Combine(Target, ".creator-project-setup");

    [Serializable]
    private sealed class SeedResult
    {
        public bool success;
        public bool creatorSdkInstalled;
        public bool stringBuilderSelected;
        public string unityVersion;
        public string sdkGlobalVersion;
        public int nodeCount;
        public int creatorNodeCount;
        public string checkedAtUtc;
        public string error;
    }

    private static void RequireFixture()
    {
        var project = Directory.GetParent(Application.dataPath).FullName.Replace('\\', '/');
        if (!Application.isBatchMode || !string.Equals(project, Target, StringComparison.OrdinalIgnoreCase)
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_REAL_SDK_ADD_AUDIT") != Target
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_REAL_SDK_ADD_GUARDS_REVIEWED") != "yes"
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_REAL_SDK_CACHE_RESTORE_APPROVED") != "yes"
            || string.IsNullOrEmpty(ExpectedBefore))
            throw new InvalidOperationException("This seed only runs in the explicitly approved, newly created audit fixture.");
    }

    [InitializeOnLoadMethod]
    private static void ObserveSdkPreference()
    {
        if (!Application.isBatchMode || Environment.GetEnvironmentVariable("CREATOR_SETUP_REAL_SDK_ADD_AUDIT") != Target)
            return;
        RequireFixture();
        File.AppendAllText(Path.Combine(StatusFolder, "sdk-pref-observations.jsonl"), JsonUtility.ToJson(new SeedResult
        {
            unityVersion = Application.unityVersion,
            sdkGlobalVersion = EditorPrefs.GetString(SdkPreference),
            checkedAtUtc = DateTime.UtcNow.ToString("O")
        }) + Environment.NewLine);
    }

    public static void Seed()
    {
        RequireFixture();
        try
        {
#if GREENFIELD_PROJECT
            throw new InvalidOperationException("The audit must exercise ordinary SDK startup, not GREENFIELD_PROJECT.");
#endif
            if (Application.unityVersion != ExpectedEditor)
                throw new InvalidOperationException("Unreviewed Unity Editor.");
            if (UnityEditor.PackageManager.PackageInfo.FindForPackageName("com.sidequest.creator-sdk") != null)
                throw new InvalidOperationException("The seed must run before Creator SDK is installed.");
            // The external wrapper owns the raw before-image and exact restoration after SDK import.
            if (EditorPrefs.GetString(SdkPreference) != ExpectedBefore)
                throw new InvalidOperationException("SDK cache marker differs from the approved before snapshot. Refusing SDK import; the seed did not change it.");
            VSUsageUtility.isVisualScriptingUsed = true;
            var config = BoltCore.Configuration;
            if (!config.typeOptions.Contains(typeof(StringBuilder)))
                config.typeOptions.Add(typeof(StringBuilder));
            var assembly = new LooseAssemblyName(typeof(StringBuilder).Assembly.GetName().Name);
            if (!config.assemblyOptions.Contains(assembly))
                config.assemblyOptions.Add(assembly);
            foreach (var setting in config.projectSettings) setting.Save();
            config.SaveProjectSettingsAsset(true);
            Codebase.UpdateSettings();
            EditorApplication.delayCall += Finish;
        }
        catch (Exception error) { Fail(error); }
    }

    private static void Finish()
    {
        try
        {
            RequireFixture();
            if (!File.Exists("ProjectSettings/VisualScriptingSettings.asset"))
                throw new InvalidOperationException("Seed selections were not saved.");
            UnitBase.Rebuild();
            AssetDatabase.SaveAssets();
            var result = new SeedResult
            {
                creatorSdkInstalled = UnityEditor.PackageManager.PackageInfo.FindForPackageName("com.sidequest.creator-sdk") != null,
                stringBuilderSelected = BoltCore.Configuration.typeOptions.Contains(typeof(StringBuilder)),
                unityVersion = Application.unityVersion,
                sdkGlobalVersion = EditorPrefs.GetString(SdkPreference),
                checkedAtUtc = DateTime.UtcNow.ToString("O")
            };
            using (NativeUtility.Module("sqlite3.dll"))
            using (var database = new SQLiteConnection(BoltFlow.Paths.unitOptions, SQLiteOpenFlags.ReadOnly))
            {
                var rows = database.Table<UnitOptionRow>().ToList();
                result.nodeCount = rows.Count;
                result.creatorNodeCount = rows.Count(row => row.unitType != null && row.unitType.StartsWith("BS.", StringComparison.Ordinal));
            }
            result.success = !result.creatorSdkInstalled && result.stringBuilderSelected
                && result.nodeCount > 0 && result.creatorNodeCount == 0 && result.sdkGlobalVersion == ExpectedBefore;
            File.WriteAllText(Path.Combine(StatusFolder, "plain-urp-seed.json"), JsonUtility.ToJson(result, true));
            EditorApplication.Exit(result.success ? 0 : 2);
        }
        catch (Exception error) { Fail(error); }
    }

    private static void Fail(Exception error)
    {
        Debug.LogException(error);
        File.WriteAllText(Path.Combine(StatusFolder, "plain-urp-seed.json"), JsonUtility.ToJson(new SeedResult
        {
            error = error.ToString(),
            checkedAtUtc = DateTime.UtcNow.ToString("O")
        }, true));
        EditorApplication.Exit(2);
    }
}
