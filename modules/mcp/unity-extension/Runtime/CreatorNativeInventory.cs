using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace CreatorWorks.Diagnostics
{
    // Host-owned, opt-in component. No automatic installation, network listener or update loop.
    [DisallowMultipleComponent]
    public sealed class CreatorNativeInventory : MonoBehaviour
    {
        private int mainThreadId;
        private string projectId;
        private string sessionId;
        private NativeInventoryExportSession exportSession;
        public string SessionId { get { return sessionId; } }
        public string ExportDirectory { get { return exportSession == null ? null : exportSession.DirectoryPath; } }
        public string LastCleanupError { get; private set; }

        private void Awake() { mainThreadId = Thread.CurrentThread.ManagedThreadId; }
        private void OnDisable() { Revoke(); }
        private void OnDestroy() { Revoke(); }
        private void OnApplicationQuit() { Revoke(); }
        private void OnApplicationPause(bool paused) { if (paused) Revoke(); }
        public void Revoke() { string error; TryRevoke(out error); }
        public bool TryRevoke(out string error)
        {
            error = null;
            if (mainThreadId != 0 && Thread.CurrentThread.ManagedThreadId != mainThreadId)
            { error = "Revoke approval on the Unity main thread."; LastCleanupError = error; return false; }
            projectId = null; sessionId = null;
            var previous = exportSession;
            bool ok = previous == null || previous.TryClose(out error);
            if (ok || previous.RevocationVerified || previous.LeaseExpired) exportSession = null;
            LastCleanupError = error;
            return ok;
        }

        public bool TryApproveExport(string projectRoot, string approvedProjectId, bool userApproved, int leaseSeconds, out string error)
        {
            if (!TryApprove(approvedProjectId, userApproved, out error)) return false;
            if (NativeInventoryExportSession.TryOpen(projectRoot, projectId, sessionId, leaseSeconds, out exportSession, out error)) return true;
            Revoke(); return false;
        }

        public bool TryCaptureAndPublish(int maxNodes, int maxDepth, int maxMilliseconds, out string error)
        { return TryCaptureAndPublish(maxNodes, maxDepth, maxMilliseconds, CancellationToken.None, out error); }

        public bool TryCaptureAndPublish(int maxNodes, int maxDepth, int maxMilliseconds, CancellationToken cancellation, out string error)
        {
            string json;
            if (cancellation.IsCancellationRequested) { error = "Capture was cancelled."; return false; }
            if (exportSession == null) { error = "No approved export session. Approve a specific project directory first."; return false; }
            if (!TryCapture(maxNodes, maxDepth, maxMilliseconds, out json, out error)) return false;
            if (cancellation.IsCancellationRequested) { Revoke(); error = "Capture was cancelled before publication."; return false; }
            bool published = exportSession.TryPublish(json, out error);
            if (cancellation.IsCancellationRequested) { Revoke(); error = LastCleanupError ?? "Capture was cancelled; export withdrawn."; return false; }
            return published;
        }

        // The native host must obtain consent itself and supply the MCP project's stable ID.
        public bool TryApprove(string approvedProjectId, bool userApproved, out string error)
        {
            error = null;
            if (Thread.CurrentThread.ManagedThreadId != mainThreadId || mainThreadId == 0)
            { error = "Call from the Unity main thread after Awake."; return false; }
            if (!TryRevoke(out error)) return false;
#if !UNITY_6000_0_OR_NEWER
            error = "Only Unity 6 is supported by this helper."; return false;
#else
            if (!userApproved) { error = "Runtime inventory has not been approved."; return false; }
            if (!isActiveAndEnabled || !Application.isPlaying || Application.isEditor)
            { error = "An active native player component is required; Editor captures are refused."; return false; }
            if (approvedProjectId == null || !Regex.IsMatch(approvedProjectId, "^unity-[a-f0-9]{20}$") ||
                string.IsNullOrEmpty(Application.buildGUID))
            { error = "A project ID and native build GUID are required."; return false; }
            projectId = approvedProjectId;
            sessionId = Guid.NewGuid().ToString("N");
            return true;
#endif
        }

        public bool TryCapture(int maxNodes, int maxDepth, int maxMilliseconds, out string json, out string error)
        {
            json = null; error = null;
            if (Thread.CurrentThread.ManagedThreadId != mainThreadId || mainThreadId == 0)
            { error = "Capture must run on the Unity main thread."; return false; }
            if (sessionId == null || !isActiveAndEnabled || !Application.isPlaying || Application.isEditor)
            { error = "Native inventory is disabled. Obtain explicit session approval first."; return false; }
            if (maxNodes < 1 || maxNodes > 1000 || maxDepth < 0 || maxDepth > 64 || maxMilliseconds < 1 || maxMilliseconds > 50)
            { error = "Bounds: nodes 1..1000, depth 0..64, milliseconds 1..50."; return false; }
            try
            {
                var timer = Stopwatch.StartNew();
                var capture = new Snapshot {
                    producer = new Producer { applicationId = Clean(Application.identifier, 128), buildGuid = Clean(Application.buildGUID, 128),
                        unityVersion = Clean(Application.unityVersion, 128), platform = Application.platform.ToString(), isEditor = Application.isEditor },
                    capture = new Capture { projectId = projectId, sessionId = sessionId, snapshotId = Guid.NewGuid().ToString("N"),
                        capturedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), frame = Time.frameCount },
                    coverage = new Coverage { maxNodes = maxNodes, maxDepth = maxDepth, maxMilliseconds = maxMilliseconds }
                };
                var nodes = new List<Node>(maxNodes);
                var roots = new List<GameObject>(maxNodes + 1);
                var stack = new Stack<Visit>(maxDepth + 1);
                int sceneCount = SceneManager.sceneCount;
                if (sceneCount > 64) Truncate(capture.coverage, "scene-limit");
                bool stop = false;
                for (int s = 0; s < Math.Min(sceneCount, 64) && !stop; s++)
                {
                    if (Expired(timer, maxMilliseconds)) { Truncate(capture.coverage, "time-limit"); break; }
                    var scene = SceneManager.GetSceneAt(s);
                    if (!scene.IsValid() || !scene.isLoaded) continue;
                    // Precheck before Unity fills the list. Do not allocate arrays for a huge scene.
                    if (scene.rootCount > maxNodes - nodes.Count)
                    { Truncate(capture.coverage, "node-limit"); break; }
                    roots.Clear();
                    scene.GetRootGameObjects(roots);
                    for (int r = 0; r < roots.Count && !stop; r++)
                    {
                        if (!roots[r]) continue;
                        stack.Clear();
                        stack.Push(new Visit { transform = roots[r].transform, parentId = 0, depth = 0 });
                        while (stack.Count > 0)
                        {
                            if (Expired(timer, maxMilliseconds)) { Truncate(capture.coverage, "time-limit"); stop = true; break; }
                            var visit = stack.Pop();
                            if (!visit.transform) continue;
                            var go = visit.transform.gameObject;
                            if (!visit.entered)
                            {
                                if (nodes.Count >= maxNodes) { Truncate(capture.coverage, "node-limit"); stop = true; break; }
                                Renderer renderer;
                                bool present = go.TryGetComponent<Renderer>(out renderer);
                                nodes.Add(new Node { id = go.GetInstanceID(), parentId = visit.parentId, sceneId = scene.handle,
                                    name = Clean(go.name, 256), activeSelf = go.activeSelf, activeInHierarchy = go.activeInHierarchy,
                                    firstRenderer = new RendererHint { present = present, enabled = present && renderer.enabled,
                                        isVisibleHint = present && renderer.isVisible } });
                                visit.entered = true;
                            }
                            int children = visit.transform.childCount;
                            if (visit.depth >= maxDepth && children > 0)
                            { Truncate(capture.coverage, "depth-limit"); continue; }
                            if (visit.nextChild < children)
                            {
                                var child = visit.transform.GetChild(visit.nextChild++);
                                stack.Push(visit);
                                stack.Push(new Visit { transform = child, parentId = go.GetInstanceID(), depth = visit.depth + 1 });
                            }
                        }
                    }
                }
                capture.nodes = nodes.ToArray();
                capture.coverage.elapsedMilliseconds = timer.Elapsed.TotalMilliseconds;
                json = JsonUtility.ToJson(capture);
                if (Encoding.UTF8.GetByteCount(json) > 1024 * 1024)
                { json = null; error = "Capture exceeds the 1 MiB snapshot limit; reduce maxNodes."; return false; }
                return true;
            }
            catch (Exception ex)
            {
                json = null;
                error = "Capture failed without changing scene data: " + ex.GetType().Name;
                return false;
            }
        }

        private static bool Expired(Stopwatch timer, int limit) { return timer.Elapsed.TotalMilliseconds >= limit; }
        private static void Truncate(Coverage coverage, string reason)
        { if (!coverage.truncated) { coverage.truncated = true; coverage.reason = reason; } }
        private static string Clean(string value, int limit)
        {
            if (value == null) return "";
            var output = new StringBuilder(Math.Min(value.Length, limit));
            for (int i = 0; i < value.Length && output.Length < limit; i++)
                output.Append(char.IsControl(value[i]) ? ' ' : value[i]);
            return output.ToString();
        }
        private struct Visit { public Transform transform; public int parentId, depth, nextChild; public bool entered; }
        [Serializable] private sealed class Snapshot { public int schemaVersion = 1; public Producer producer; public Capture capture; public Coverage coverage; public Node[] nodes; }
        [Serializable] private sealed class Producer { public string name = "creator-works-native-inventory"; public int version = 1; public string applicationId, buildGuid, unityVersion, platform; public bool isEditor; }
        [Serializable] private sealed class Capture { public string projectId, sessionId, snapshotId; public long capturedAtUnixMs; public int frame; }
        [Serializable] private sealed class Coverage { public string scope = "loaded-scene-hierarchy", cameraSubmission = "unknown", reason = "none"; public bool truncated; public int maxNodes, maxDepth, maxMilliseconds; public double elapsedMilliseconds; }
        [Serializable] private sealed class Node { public int id, parentId, sceneId; public string name; public bool activeSelf, activeInHierarchy; public RendererHint firstRenderer; }
        [Serializable] private sealed class RendererHint { public bool present, enabled, isVisibleHint; }
    }
}
