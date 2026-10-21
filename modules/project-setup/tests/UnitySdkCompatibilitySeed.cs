using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using BS.SDKEditor;
using BS.SDKEditor.Setup;
using CreatorWorks;
using Unity.VisualScripting;
using Unity.VisualScripting.Dependencies.Sqlite;
using UnityEditor;
using UnityEngine;

// Disposable test only. The parent runner must close human Editors and guard these exact
// logical EditorPrefs keys before Unity starts. This code never restores or writes them.
public static class UnitySdkCompatibilitySeed
{
    private const string Target = "E:/UnityTest/CreatorSetupSdk4022Vs1912-Repair-20261021";
    private const string ExpectedEditor = "@@EDITOR_VERSION@@";
    private const string Marker = "Banter_GeneratedVSNodesVersion";
    private static string StatusFolder => Path.Combine(Target, ".creator-project-setup");

    public static readonly string[] PreferenceKeys = {
        "VisualScripting.Core.dimInactiveNodes", "VisualScripting.Core.dimIncompatibleNodes",
        "VisualScripting.Core.showVariablesHelp", "VisualScripting.Core.createSceneVariables",
        "VisualScripting.Core.showGrid", "VisualScripting.Core.snapToGrid",
        "VisualScripting.Core.panSpeed", "VisualScripting.Core.dragPanSpeed",
        "VisualScripting.Core.zoomSpeed", "VisualScripting.Core.overviewSmoothing",
        "VisualScripting.Core.carryChildren", "VisualScripting.Core.disablePlaymodeTint",
        "VisualScripting.Core.debug", "VisualScripting.Core.controlScheme",
        "VisualScripting.Core.clearGraphSelection", "VisualScripting.Core.humanNaming",
        "VisualScripting.Core.maxSearchResults", "VisualScripting.Core.groupInheritedMembers",
        "VisualScripting.Core.limitFuzzyFinderHeight", "VisualScripting.Core.developerMode",
        "VisualScripting.Core.trackMetadataState", "VisualScripting.Core.debugInspectorGUI",
        "VisualScripting.Core.editorSetupCompleted",
        "VisualScripting.Flow.updateNodesAutomatically", "VisualScripting.Flow.predictPotentialNullReferences",
        "VisualScripting.Flow.predictPotentialMissingComponents", "VisualScripting.Flow.showConnectionValues",
        "VisualScripting.Flow.predictConnectionValues", "VisualScripting.Flow.hidePortLabels",
        "VisualScripting.Flow.animateControlConnections", "VisualScripting.Flow.animateValueConnections",
        "VisualScripting.Flow.skipContextMenu", "VisualScripting.Flow.editorSetupCompleted",
        "VisualScripting.State.statesReveal", "VisualScripting.State.transitionsReveal",
        "VisualScripting.State.transitionsEndArrow", "VisualScripting.State.animateTransitions",
        "VisualScripting.State.editorSetupCompleted"
    };

    [Serializable]
    private sealed class PreferencePin { public string key; public bool present; public string sha256; }
    [Serializable]
    private sealed class Audit
    {
        public string phase;
        public string unityVersion;
        public string creatorSdkVersion;
        public string visualScriptingVersion;
        public string creatorSdkSource;
        public string visualScriptingSource;
        public bool customTypePreserved;
        public bool customAssemblyPreserved;
        public bool sdkReadyDone;
        public string sdkReadinessState;
        public string sdkReadinessSummary;
        public bool nodesBuiltForThisVersion;
        public string nodesBuiltForVersion;
        public bool nodeDatabaseExists;
        public bool markerUnchanged;
        public bool malformedNodePayloadRejected;
        public PreferencePin[] editorPreferences;
        public bool releaseAcceptance;
        public string error;
    }

    private static void RequireFixture()
    {
        var root = Directory.GetParent(Application.dataPath).FullName.Replace('\\', '/');
        if (!Application.isBatchMode || !string.Equals(root, Target, StringComparison.OrdinalIgnoreCase)
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_AUDIT") != Target
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_GUARDS_REVIEWED") != "yes"
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_EDITORS_CLOSED") != "yes"
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_PREF_GUARD_REVIEWED") != "yes"
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_PREPARED_BASELINE_REVIEWED") != "yes"
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_VS38_PREF_BACKUP_APPROVED") != "yes"
            || Environment.GetEnvironmentVariable("CREATOR_SETUP_REAL_SDK_CACHE_EXPECTED_BEFORE") == null
            || (Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_MARKER_EXPECTED_PRESENT") != "yes"
                && Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_MARKER_EXPECTED_PRESENT") != "no"))
            throw new InvalidOperationException("Unreviewed compatibility runtime fixture or preference guard.");
#if GREENFIELD_PROJECT
        throw new InvalidOperationException("Ordinary SDK startup is required.");
#endif
        if (Application.unityVersion != ExpectedEditor
            || Version("com.sidequest.creator-sdk") != "4.0.22"
            || Version("com.unity.visualscripting") != "1.9.12"
            || PackageSource("com.sidequest.creator-sdk") != "Registry"
            || PackageSource("com.unity.visualscripting") != "Registry")
            throw new InvalidOperationException("Resolved packages do not match the qualification pair.");
        if (!MarkerUnchanged())
            throw new InvalidOperationException("SDK global marker changed; external restoration guard owns recovery.");
    }

    private static string Version(string name) => UnityEditor.PackageManager.PackageInfo.FindForPackageName(name)?.version ?? "missing";
    private static string PackageSource(string name) => UnityEditor.PackageManager.PackageInfo.FindForPackageName(name)?.source.ToString() ?? "missing";

    private static bool MarkerUnchanged() =>
        EditorPrefs.HasKey(Marker) == (Environment.GetEnvironmentVariable("CREATOR_SETUP_SDK_COMPATIBILITY_MARKER_EXPECTED_PRESENT") == "yes")
        && EditorPrefs.GetString(Marker) == Environment.GetEnvironmentVariable("CREATOR_SETUP_REAL_SDK_CACHE_EXPECTED_BEFORE");

    private static Audit Capture(string phase)
    {
        RequireFixture();
        var check = ProjectSetup.Checks.Single(item => item.Id == "sdk.visual-scripting");
        var status = ProjectSetup.Evaluate(check);
        var config = BoltCore.Configuration;
        var audit = new Audit {
            phase = phase, unityVersion = Application.unityVersion,
            creatorSdkVersion = Version("com.sidequest.creator-sdk"),
            visualScriptingVersion = Version("com.unity.visualscripting"),
            creatorSdkSource = PackageSource("com.sidequest.creator-sdk"),
            visualScriptingSource = PackageSource("com.unity.visualscripting"),
            customTypePreserved = config.typeOptions.Contains(typeof(StringBuilder))
                && config.typeOptions.Contains(typeof(System.Xml.Linq.XDocument)),
            customAssemblyPreserved = config.assemblyOptions.Contains(new LooseAssemblyName(typeof(System.Xml.Linq.XDocument).Assembly.GetName().Name)),
            sdkReadyDone = status.State == SetupState.Done,
            sdkReadinessState = status.State.ToString(), sdkReadinessSummary = status.Summary,
            nodesBuiltForThisVersion = VsNodeGeneration.NodesBuiltForThisVersion,
            nodesBuiltForVersion = VsNodeGeneration.NodesBuiltForVersion,
            nodeDatabaseExists = VsNodeGeneration.NodeDatabaseExists,
            markerUnchanged = MarkerUnchanged(),
            malformedNodePayloadRejected = malformedNodePayloadRejected,
            editorPreferences = PreferenceKeys.Select(key => new PreferencePin {
                key = key, present = EditorPrefs.HasKey(key), sha256 = Hash(EditorPrefs.GetString(key))
            }).ToArray(), releaseAcceptance = false
        };
        WriteNew("sdk-compatibility-" + phase + ".json", JsonUtility.ToJson(audit, true));
        return audit;
    }

    public static void Seed()
    {
        try {
            // The source was already prepared by Unity. Verify it without reseeding
            // missing custom selections or hiding changes made by this new import.
            var receipt = Capture("seed");
            if (!receipt.customTypePreserved || !receipt.customAssemblyPreserved)
                throw new InvalidOperationException("Prepared custom selections are missing.");
            EditorApplication.Exit(0);
        } catch (Exception error) { Fail(error); }
    }

    public static void ConfigureExisting()
    {
        try {
            Capture("before-configure");
            ProjectSetupValidator.ConfigureExisting();
        } catch (Exception error) { Fail(error); }
    }

    public static void Validate()
    {
        try {
            RequireFixture();
            Application.logMessageReceivedThreaded += ReloadLog;
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(UnitBase).TypeHandle);
            reloadClock = System.Diagnostics.Stopwatch.StartNew();
            BackgroundWorker.Schedule(() => System.Threading.Interlocked.Exchange(ref reloadReady, 1));
            EditorApplication.update += WaitForReload;
        } catch (Exception error) { Fail(error); }
    }

    private static int reloadReady, reloadErrors;
    private static bool malformedNodePayloadRejected;
    private static System.Diagnostics.Stopwatch reloadClock;

    private static void ReloadLog(string message, string stack, LogType type)
    {
        if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert)
            System.Threading.Interlocked.Increment(ref reloadErrors);
    }

    private static void RequireReloadReady(bool markerRequired)
    {
        if (reloadClock.Elapsed.TotalSeconds >= 30 || System.Threading.Volatile.Read(ref reloadErrors) != 0
            || (markerRequired && System.Threading.Volatile.Read(ref reloadReady) != 1))
            throw new InvalidOperationException("The qualification reload loader failed or exceeded its deadline.");
    }

    private static void WaitForReload()
    {
        try {
            RequireReloadReady(false);
            UnityAPI.ProcessDelegates();
            RequireReloadReady(false);
            if (System.Threading.Volatile.Read(ref reloadReady) != 1) return;
            EditorApplication.update -= WaitForReload;
            // Observe BackgroundWorker's earlier delayCall exception reports first.
            EditorApplication.delayCall += FinishReloadQualification;
        } catch (Exception error) { Fail(error); }
    }

    private static void FinishReloadQualification()
    {
        try {
            RequireReloadReady(true);
            using (NativeUtility.Module("sqlite3.dll"))
            using (var database = new SQLiteConnection(BoltFlow.Paths.unitOptions, SQLiteOpenFlags.ReadOnly)) {
                var row = database.Table<UnitOptionRow>().ToList().First(item => item.unitType != null
                    && item.unitType.StartsWith("BS.", StringComparison.Ordinal));
                AssertMalformedNodePayloadRejected(row);
            }
            RequireReloadReady(true);
            malformedNodePayloadRejected = true;
            // This is the existing fresh reload process, not another Unity launch.
            Capture("reloaded");
            ProjectSetupValidator.Validate();
        } catch (Exception error) { Fail(error); }
        finally { Application.logMessageReceivedThreaded -= ReloadLog; }
    }

    // The qualification reload exercises a copied row only. No DB writes.
    public static void AssertMalformedNodePayloadRejected(UnitOptionRow original)
    {
        RequireFixture();
        ProjectSetupValidator.VerifyCandidateNodeRow(original);
        var originalPayload = original.unit;
        var malformed = new UnitOptionRow();
        foreach (var property in typeof(UnitOptionRow).GetProperties()) {
            if (!property.CanRead || !property.CanWrite
                || (property.PropertyType != typeof(string) && property.PropertyType != typeof(int)))
                throw new InvalidOperationException("Unreviewed node row field in the deferred payload regression.");
            property.SetValue(malformed, property.GetValue(original));
        }
        malformed.unit = "{";
        var metadata = malformed.ToOption();
        if (metadata == null || metadata.unitType == null)
            throw new InvalidOperationException("Malformed payload control did not retain valid option metadata.");
        var refused = false;
        try { ProjectSetupValidator.VerifyCandidateNodeRow(malformed); }
        catch (System.Runtime.Serialization.SerializationException error) when (error.InnerException != null) { refused = true; }
        if (!refused || original.unit != originalPayload)
            throw new InvalidOperationException("The malformed node payload was not rejected without changing the source row.");
    }

    private static string Hash(string value)
    {
        using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
    }

    private static void WriteNew(string name, string text)
    {
        using (var file = new FileStream(Path.Combine(StatusFolder, name), FileMode.CreateNew, FileAccess.Write)) {
            var bytes = Encoding.UTF8.GetBytes(text);
            file.Write(bytes, 0, bytes.Length);
            file.Flush(true);
        }
    }

    private static void Fail(Exception error)
    {
        EditorApplication.update -= WaitForReload;
        EditorApplication.delayCall -= FinishReloadQualification;
        Application.logMessageReceivedThreaded -= ReloadLog;
        Debug.LogException(error);
        WriteNew("sdk-compatibility-error.json", JsonUtility.ToJson(new Audit { error = error.ToString() }, true));
        EditorApplication.Exit(2);
    }
}
