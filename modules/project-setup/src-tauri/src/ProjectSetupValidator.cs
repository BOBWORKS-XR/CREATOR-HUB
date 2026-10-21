using System;
using System.IO;
using System.Linq;
using BS.SDKEditor;
using Unity.VisualScripting;
using Unity.VisualScripting.Dependencies.Sqlite;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace CreatorWorks
{
    public static class ProjectSetupValidator
    {
        private static string StatusFolder => Path.Combine(Directory.GetParent(Application.dataPath).FullName, ".creator-project-setup");

        [Serializable]
        private sealed class Result
        {
            public bool success;
            public string unityVersion;
            public string creatorSdkVersion;
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
            public string visualScriptingVersion;
            public string sdkReadinessState;
            public bool sdkReadyDone;
            public bool nodesBuiltForThisVersion;
            public bool nodeDatabaseVerified;
#endif
            public string urpVersion;
            public string inputSystemVersion;
            public bool urpConfigured;
            public bool androidSupported;
            public bool windowsSupported;
            public bool visualScriptingInitialized;
            public bool creatorVisualScriptingConfigured;
            public int nodeCount;
            public int creatorNodeCount;
            public bool preservedVisualScriptingSelections;
            public string checkedAtUtc;
            public string error;
        }

        public static void Configure()
        {
            Configure(false);
        }

        public static void ConfigureExisting()
        {
            Configure(true);
        }

        [Serializable]
        private sealed class ExistingRequest { public string backupPath; }
        private static bool preserveSelections;

        private static DictionaryAsset OriginalSelections()
        {
            var path = Path.Combine(StatusFolder, "existing-request.json");
            if (!File.Exists(path)) return null;
            var request = JsonUtility.FromJson<ExistingRequest>(File.ReadAllText(path));
            var original = Path.Combine(request.backupPath, "ProjectSettings", "VisualScriptingSettings.asset");
            if (!File.Exists(original) || new FileInfo(original).Length == 0) return null;
            var saved = UnityEditorInternal.InternalEditorUtility.LoadSerializedFileAndForget(original).OfType<DictionaryAsset>().FirstOrDefault();
            if (saved == null) throw new InvalidOperationException("The original Visual Scripting settings could not be loaded. Backup retained.");
            return saved;
        }

        private static void Configure(bool preserve)
        {
            try
            {
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                RequireCandidatePair();
                WriteCandidateStampBeforeImage();
                BeginCandidateErrorWatch();
#endif
                Progress(4, "Initializing Visual Scripting and saving Creator SDK type settings.");
                VSUsageUtility.isVisualScriptingUsed = true;
                var config = BoltCore.Configuration;
                preserveSelections = preserve;
                if (!preserve) { config.assemblyOptions.Clear(); config.typeOptions.Clear(); }
                else
                {
                    // SDK startup callbacks can run before executeMethod. Merge the reviewed
                    // backup's selections as well, so their startup cannot erase user additions.
                    var saved = OriginalSelections();
                    if (saved != null)
                    {
                        if (saved.ContainsKey("assemblyOptions"))
                            foreach (var assembly in (System.Collections.Generic.List<LooseAssemblyName>)saved["assemblyOptions"])
                                if (!config.assemblyOptions.Contains(assembly)) config.assemblyOptions.Add(assembly);
                        if (saved.ContainsKey("typeOptions"))
                            foreach (var type in (System.Collections.Generic.List<Type>)saved["typeOptions"])
                                if (type != null && !config.typeOptions.Contains(type)) config.typeOptions.Add(type);
                    }
                }
                foreach (var name in VsNodeGeneration.assemblyAllowList)
                    if (!config.assemblyOptions.Contains(new LooseAssemblyName(name))) config.assemblyOptions.Add(new LooseAssemblyName(name));
                foreach (var type in VsNodeGeneration.typeAllowList)
                    if (!config.typeOptions.Contains(type)) config.typeOptions.Add(type);
                foreach (var setting in config.projectSettings) setting.Save();
                config.SaveProjectSettingsAsset(true);
                Codebase.UpdateSettings();
                // Unity schedules settings serialization on delayCall, even with immediately=true.
                // Do not exit batch mode until that callback and the SDK's node generation finish.
                EditorApplication.delayCall += FinishConfiguration;
            }
            catch (Exception error)
            {
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                FailCandidate(error);
#else
                Fail(error);
#endif
            }
        }

        private static void FinishConfiguration()
        {
            try
            {
                if (!File.Exists("ProjectSettings/VisualScriptingSettings.asset"))
                    throw new InvalidOperationException("Visual Scripting settings were not saved.");
                Progress(4, "Generating the Creator SDK Visual Scripting node database.");
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                BeginCandidateConfiguration();
#else
                if (preserveSelections) UnitBase.Rebuild();
                else VsNodeGeneration.SetVSTypesAndAssemblies();
                AssetDatabase.SaveAssets();
                EditorApplication.Exit(0);
#endif
            }
            catch (Exception error) { Fail(error); }
        }

#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
        private const string CandidateStampKey = "BS.SDK.VisualScriptingNodes";
        private static string candidateSdkStamp;
        private static LooseAssemblyName[] candidateAssemblies;
        private static Type[] candidateTypes;
        private static int candidateErrors, candidateLoaderDone;
        private static bool candidateWatchingErrors, candidateStampManaged;
        private static System.Diagnostics.Stopwatch candidateLoaderClock;
        private static EditorApplication.CallbackFunction candidateAfterLoader;
        private static string candidateStampBeforeValue;

        [Serializable]
        private sealed class CandidateStampBeforeImage
        {
            public int schemaVersion = 1;
            public string key;
            public bool apiValueWasNull;
            public string value;
            public string creatorSdkVersion;
            public string visualScriptingVersion;
            public bool restorationPerformed;
        }

        private static void WriteCandidateStampBeforeImage()
        {
            candidateStampBeforeValue = EditorUserSettings.GetConfigValue(CandidateStampKey);
            if (candidateStampBeforeValue != null && candidateStampBeforeValue.Length > 4096)
                throw new InvalidOperationException("The candidate stamp before-image is outside its bound.");
            var evidence = new CandidateStampBeforeImage {
                key = CandidateStampKey, apiValueWasNull = candidateStampBeforeValue == null,
                value = candidateStampBeforeValue ?? "", creatorSdkVersion = PackageVersion("com.sidequest.creator-sdk"),
                visualScriptingVersion = PackageVersion("com.unity.visualscripting"), restorationPerformed = false
            };
            var bytes = System.Text.Encoding.UTF8.GetBytes(JsonUtility.ToJson(evidence, true));
            var path = Path.Combine(StatusFolder, "sdk4022-node-stamp-before.json");
            using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                file.Write(bytes, 0, bytes.Length);
                file.Flush(true);
            }
            if (!File.ReadAllBytes(path).SequenceEqual(bytes)
                || EditorUserSettings.GetConfigValue(CandidateStampKey) != candidateStampBeforeValue)
                throw new InvalidOperationException("The candidate stamp before-image drifted. Evidence and backups retained.");
        }

        private static void RequireCandidatePair()
        {
            if (PackageVersion("com.sidequest.creator-sdk") != "@@CREATOR_SDK_VERSION@@"
                || PackageVersion("com.unity.visualscripting") != "@@VISUAL_SCRIPTING_VERSION@@")
                throw new InvalidOperationException("The exact candidate SDK/Visual Scripting pair is required. Backups retained.");
        }

        private static void CandidateLog(string message, string stack, LogType type)
        {
            if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert)
                System.Threading.Interlocked.Increment(ref candidateErrors);
        }

        private static void BeginCandidateErrorWatch()
        {
            if (candidateWatchingErrors) throw new InvalidOperationException("A candidate configuration is already active.");
            candidateErrors = 0;
            Application.logMessageReceivedThreaded += CandidateLog;
            candidateWatchingErrors = true;
        }

        private static void EndCandidateErrorWatch()
        {
            if (candidateWatchingErrors) Application.logMessageReceivedThreaded -= CandidateLog;
            candidateWatchingErrors = false;
        }

        private static void RequireNoCandidateErrors()
        {
            if (System.Threading.Volatile.Read(ref candidateErrors) != 0)
                throw new InvalidOperationException("Visual Scripting logged an error; a returning builder is not success. Backups retained.");
        }

        private static void BeginCandidateConfiguration()
        {
            try
            {
                RequireCandidatePair();
                candidateAssemblies = BoltCore.Configuration.assemblyOptions.ToArray();
                candidateTypes = BoltCore.Configuration.typeOptions.ToArray();
                QueueAfterCandidateLoader(ConfigureCandidateAfterLoader);
            }
            catch (Exception error) { FailCandidate(error); }
        }

        private static void QueueAfterCandidateLoader(EditorApplication.CallbackFunction continuation)
        {
            // AutoLoad is queued once by this constructor. The FIFO marker runs
            // after it releases UnitBase's lock, including automatic-update work.
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(UnitBase).TypeHandle);
            candidateAfterLoader = continuation;
            candidateLoaderDone = 0;
            candidateLoaderClock = System.Diagnostics.Stopwatch.StartNew();
            BackgroundWorker.Schedule(() => System.Threading.Interlocked.Exchange(ref candidateLoaderDone, 1));
            EditorApplication.update += WaitForCandidateLoader;
        }

        private static void WaitForCandidateLoader()
        {
            try
            {
                if (candidateLoaderClock.Elapsed.TotalSeconds >= 30)
                    throw new TimeoutException("Visual Scripting background loading did not finish; no SDK setup was started.");
                UnityAPI.ProcessDelegates();
                RequireNoCandidateErrors();
                if (candidateLoaderClock.Elapsed.TotalSeconds >= 30)
                    throw new TimeoutException("Visual Scripting background loading exceeded the candidate deadline.");
                if (System.Threading.Volatile.Read(ref candidateLoaderDone) != 1) return;
                EditorApplication.update -= WaitForCandidateLoader;
                // BackgroundWorker queues caught exceptions on delayCall before
                // reaching the marker. Observe those logs before this continuation.
                EditorApplication.delayCall += candidateAfterLoader;
            }
            catch (Exception error) { FailCandidate(error); }
        }

        private static void ClearCandidateStamp()
        {
            EditorUserSettings.SetConfigValue(CandidateStampKey, "");
            if (!string.IsNullOrEmpty(EditorUserSettings.GetConfigValue(CandidateStampKey)))
                throw new InvalidOperationException("The candidate node stamp could not be cleared. Backups retained.");
        }

        private static void RequireCandidateLoaderReady()
        {
            if (System.Threading.Volatile.Read(ref candidateLoaderDone) != 1
                || candidateLoaderClock.Elapsed.TotalSeconds >= 30)
                throw new TimeoutException("The candidate loader continuation is no longer authorized.");
            RequireNoCandidateErrors();
        }

        private static void ConfigureCandidateAfterLoader()
        {
            try
            {
                candidateAfterLoader = null;
                RequireCandidateLoaderReady();
                RequireNoCandidateErrors();
                RequireCandidatePair();
                if (EditorUserSettings.GetConfigValue(CandidateStampKey) != candidateStampBeforeValue)
                    throw new InvalidOperationException("The candidate stamp changed before SDK setup. Evidence retained.");
                candidateStampManaged = true;
                if (!VsNodeGeneration.SetVSTypesAndAssemblies())
                    throw new InvalidOperationException("The SDK refused node setup. Backups retained.");
                candidateSdkStamp = EditorUserSettings.GetConfigValue(CandidateStampKey);
                if (string.IsNullOrEmpty(candidateSdkStamp) || !VsNodeGeneration.NodesBuiltForThisVersion)
                    throw new InvalidOperationException("The SDK did not publish its own current node stamp.");
                ClearCandidateStamp();
                RequireNoCandidateErrors();
                var config = BoltCore.Configuration;
                foreach (var assembly in candidateAssemblies)
                    if (!config.assemblyOptions.Contains(assembly)) config.assemblyOptions.Add(assembly);
                foreach (var type in candidateTypes)
                    if (!config.typeOptions.Contains(type)) config.typeOptions.Add(type);
                foreach (var setting in config.projectSettings) setting.Save();
                config.SaveProjectSettingsAsset(true);
                Codebase.UpdateSettings();
                EditorApplication.delayCall += FinishCandidateConfiguration;
            }
            catch (Exception error) { FailCandidate(error); }
        }

        private static void CheckCandidateSelectionsSaved()
        {
            var saved = UnityEditorInternal.InternalEditorUtility.LoadSerializedFileAndForget("ProjectSettings/VisualScriptingSettings.asset")
                .OfType<DictionaryAsset>().SingleOrDefault();
            if (saved == null || !saved.ContainsKey("assemblyOptions") || !saved.ContainsKey("typeOptions")
                || !candidateAssemblies.All(((System.Collections.Generic.List<LooseAssemblyName>)saved["assemblyOptions"]).Contains)
                || !candidateTypes.All(((System.Collections.Generic.List<Type>)saved["typeOptions"]).Contains)
                || !candidateAssemblies.All(BoltCore.Configuration.assemblyOptions.Contains)
                || !candidateTypes.All(BoltCore.Configuration.typeOptions.Contains))
                throw new InvalidOperationException("Retained Visual Scripting selections were not saved. Backups retained.");
        }

        private static System.Collections.Generic.List<UnitOptionRow> ReadCandidateNodeDatabase()
        {
            using (NativeUtility.Module("sqlite3.dll"))
            using (var database = new SQLiteConnection(BoltFlow.Paths.unitOptions, SQLiteOpenFlags.ReadOnly))
            {
                if (database.ExecuteScalar<string>("PRAGMA quick_check") != "ok")
                    throw new InvalidOperationException("The rebuilt node database failed its read-only integrity check.");
                var rows = database.Table<UnitOptionRow>().ToList();
                if (rows.Count == 0 || !rows.Any(row => row.unitType != null && row.unitType.StartsWith("BS.", StringComparison.Ordinal)))
                    throw new InvalidOperationException("The rebuilt database has no verified Creator nodes.");
                foreach (var row in rows) VerifyCandidateNodeRow(row);
                return rows;
            }
        }

        internal static void VerifyCandidateNodeRow(UnitOptionRow row)
        {
            if (row == null || string.IsNullOrEmpty(row.unit) || string.IsNullOrEmpty(row.unitType)
                || string.IsNullOrEmpty(row.optionType))
                throw new InvalidOperationException("A rebuilt node row could not be loaded.");
            var option = row.ToOption();
            if (option == null || option.unitType == null)
                throw new InvalidOperationException("A rebuilt node option has no resolvable unit type.");
            // ToOption loads metadata only. The supported property performs the
            // deferred SerializationData decode used when the fuzzy finder opens it.
            var unit = option.unit;
            if (unit == null || unit.GetType() != option.unitType)
                throw new InvalidOperationException("A rebuilt node payload is null or does not match its declared unit type.");
        }

        private static void FinishCandidateConfiguration()
        {
            try
            {
                CheckCandidateSelectionsSaved();
                if (!string.IsNullOrEmpty(EditorUserSettings.GetConfigValue(CandidateStampKey)))
                    throw new InvalidOperationException("The candidate stamp changed before the retained-selection rebuild.");
                UnitBase.Rebuild();
                ReadCandidateNodeDatabase();
                RequireNoCandidateErrors();
                RequireCandidatePair();
                if (!string.IsNullOrEmpty(EditorUserSettings.GetConfigValue(CandidateStampKey)))
                    throw new InvalidOperationException("The candidate stamp changed during the retained-selection rebuild.");
                // Only the exact value authored by the public SDK call is restored.
                // This is not a durable transaction; the outer operation retains backups.
                EditorUserSettings.SetConfigValue(CandidateStampKey, candidateSdkStamp);
                var status = BS.SDKEditor.Setup.ProjectSetup.Evaluate(BS.SDKEditor.Setup.ProjectSetup.Checks.Single(item => item.Id == "sdk.visual-scripting"));
                if (!VsNodeGeneration.NodesBuiltForThisVersion || status.State != BS.SDKEditor.Setup.SetupState.Done)
                    throw new InvalidOperationException("The SDK's own node readiness check did not pass.");
                AssetDatabase.SaveAssets();
                RequireNoCandidateErrors();
                EndCandidateErrorWatch();
                candidateStampManaged = false;
                EditorApplication.Exit(0);
            }
            catch (Exception error) { FailCandidate(error); }
        }

        private static void FailCandidate(Exception error)
        {
            EditorApplication.update -= WaitForCandidateLoader;
            if (candidateAfterLoader != null) EditorApplication.delayCall -= candidateAfterLoader;
            candidateAfterLoader = null;
            EditorApplication.delayCall -= FinishCandidateConfiguration;
            try { if (candidateStampManaged) ClearCandidateStamp(); }
            catch (Exception stampError) { error = new AggregateException("Candidate failed and its stamp could not be cleared. Backups retained.", error, stampError); }
            finally { EndCandidateErrorWatch(); }
            Fail(error);
        }
#endif

        // Run in a second Unity process: validate the settings actually loaded from disk,
        // not the in-memory configuration or a machine-wide SDK preference.
        public static void Validate()
        {
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
            try
            {
                RequireCandidatePair();
                BeginCandidateErrorWatch();
                QueueAfterCandidateLoader(ValidateReloaded);
            }
            catch (Exception error) { FailCandidate(error); }
#else
            ValidateReloaded();
#endif
        }

        private static void ValidateReloaded()
        {
            try
            {
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                candidateAfterLoader = null;
                RequireCandidateLoaderReady();
                RequireNoCandidateErrors();
                RequireCandidatePair();
#endif
                Progress(5, "Checking the reloaded project, build platforms and Creator node database.");
                var result = new Result
                {
                    unityVersion = Application.unityVersion,
                    creatorSdkVersion = PackageVersion("com.sidequest.creator-sdk"),
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                    visualScriptingVersion = PackageVersion("com.unity.visualscripting"),
#endif
                    urpVersion = PackageVersion("com.unity.render-pipelines.universal"),
                    inputSystemVersion = PackageVersion("com.unity.inputsystem"),
                    urpConfigured = GraphicsSettings.defaultRenderPipeline is UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset,
                    androidSupported = BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.Android, BuildTarget.Android),
                    windowsSupported = BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.Standalone, BuildTarget.StandaloneWindows64),
                    visualScriptingInitialized = File.Exists("ProjectSettings/VisualScriptingSettings.asset") && VSUsageUtility.isVisualScriptingUsed && PluginContainer.initialized,
                    preservedVisualScriptingSelections = true,
                    checkedAtUtc = DateTime.UtcNow.ToString("O")
                };
                if (result.visualScriptingInitialized)
                {
                    var config = BoltCore.Configuration;
                    result.creatorVisualScriptingConfigured = VsNodeGeneration.assemblyAllowList.All(name => config.assemblyOptions.Contains(new LooseAssemblyName(name)))
                        && VsNodeGeneration.typeAllowList.All(type => config.typeOptions.Contains(type));
                    var original = OriginalSelections();
                    if (original != null)
                    {
                        if (original.ContainsKey("assemblyOptions")) result.preservedVisualScriptingSelections &= ((System.Collections.Generic.List<LooseAssemblyName>)original["assemblyOptions"]).All(config.assemblyOptions.Contains);
                        if (original.ContainsKey("typeOptions")) result.preservedVisualScriptingSelections &= ((System.Collections.Generic.List<Type>)original["typeOptions"]).All(config.typeOptions.Contains);
                    }
                    if (File.Exists(BoltFlow.Paths.unitOptions))
                    {
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                        var nodes = ReadCandidateNodeDatabase();
                        result.nodeCount = nodes.Count;
                        result.creatorNodeCount = nodes.Count(row => row.unitType != null && row.unitType.StartsWith("BS.", StringComparison.Ordinal));
                        result.nodeDatabaseVerified = true;
#else
                        using (NativeUtility.Module("sqlite3.dll"))
                        using (var database = new SQLiteConnection(BoltFlow.Paths.unitOptions, SQLiteOpenFlags.ReadOnly))
                        {
                            var nodes = database.Table<UnitOptionRow>().ToList();
                            result.nodeCount = nodes.Count;
                            result.creatorNodeCount = nodes.Count(row => row.unitType != null && row.unitType.StartsWith("BS.", StringComparison.Ordinal));
                        }
#endif
                    }
                }
                result.success = result.unityVersion == "@@EDITOR_VERSION@@"
                    && result.creatorSdkVersion == "@@CREATOR_SDK_VERSION@@"
                    && result.urpVersion == "@@URP_VERSION@@"
                    && result.inputSystemVersion == "@@INPUT_SYSTEM_VERSION@@"
                    && result.urpConfigured && result.androidSupported && result.windowsSupported
                    && result.visualScriptingInitialized && result.creatorVisualScriptingConfigured
                    && result.nodeCount > 0 && result.creatorNodeCount > 0 && result.preservedVisualScriptingSelections;
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                var status = BS.SDKEditor.Setup.ProjectSetup.Evaluate(BS.SDKEditor.Setup.ProjectSetup.Checks.Single(item => item.Id == "sdk.visual-scripting"));
                result.sdkReadinessState = status.State.ToString();
                result.sdkReadyDone = status.State == BS.SDKEditor.Setup.SetupState.Done;
                result.nodesBuiltForThisVersion = VsNodeGeneration.NodesBuiltForThisVersion;
                result.success &= result.visualScriptingVersion == "@@VISUAL_SCRIPTING_VERSION@@"
                    && result.sdkReadyDone && result.nodesBuiltForThisVersion && result.nodeDatabaseVerified;
                RequireNoCandidateErrors();
                EndCandidateErrorWatch();
#endif
                WriteResult(result);
                EditorApplication.Exit(result.success ? 0 : 2);
            }
            catch (Exception error)
            {
#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE
                FailCandidate(error);
#else
                Fail(error);
#endif
            }
        }

        private static string PackageVersion(string name) => UnityEditor.PackageManager.PackageInfo.FindForPackageName(name)?.version ?? "missing";

        [Serializable]
        private sealed class ProgressState { public int step; public string detail; }

        private static void Progress(int step, string detail)
        {
            Directory.CreateDirectory(StatusFolder);
            File.WriteAllText(Path.Combine(StatusFolder, "unity-progress.json"), JsonUtility.ToJson(new ProgressState { step = step, detail = detail }));
        }

        private static void WriteResult(Result result)
        {
            Directory.CreateDirectory(StatusFolder);
            File.WriteAllText(Path.Combine(StatusFolder, "unity-validation.json"), JsonUtility.ToJson(result, true));
        }

        private static void Fail(Exception error)
        {
            Debug.LogException(error);
            WriteResult(new Result { error = error.ToString(), checkedAtUtc = DateTime.UtcNow.ToString("O") });
            EditorApplication.Exit(2);
        }
    }
}
