// Isolated API double for control-flow tests, not a Unity runtime acceptance test.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using CreatorWorks.Diagnostics;

namespace UnityEngine
{
    public sealed class DisallowMultipleComponent : Attribute { }
    public class Object { public static implicit operator bool(Object value) { return value != null; } }
    public class MonoBehaviour : Object { public bool isActiveAndEnabled = true; }
    public class Renderer : Object { public bool enabled = true, isVisible = true; }
    public class Transform : Object
    {
        public GameObject gameObject;
        public List<Transform> children = new List<Transform>();
        public int childCount { get { return children.Count; } }
        public Transform GetChild(int index) { return children[index]; }
    }
    public class GameObject : Object
    {
        public string name = "fixture";
        public bool activeSelf = true, activeInHierarchy = true;
        public Renderer renderer;
        public Transform transform;
        public int id;
        public static int readDelay;
        public GameObject(int value) { id = value; transform = new Transform { gameObject = this }; }
        public int GetInstanceID() { return id; }
        public bool TryGetComponent<T>(out T value) where T : class
        { if (readDelay > 0) Thread.Sleep(readDelay); value = renderer as T; return value != null; }
    }
    public static class Application
    {
        public static bool isPlaying = true, isEditor = false;
        public static string identifier = "fixture.native", buildGUID = "fixture-build", unityVersion = "6000.3.21f1", platform = "WindowsPlayer";
    }
    public static class Time { public static int frameCount = 1; }
    public static class JsonUtility
    {
        public static string ToJson(object value) { return JsonSerializer.Serialize(value, value.GetType(), new JsonSerializerOptions { IncludeFields = true }); }
        public static T FromJson<T>(string value) { return JsonSerializer.Deserialize<T>(value, new JsonSerializerOptions { IncludeFields = true }); }
    }
}
namespace UnityEngine.SceneManagement
{
    public class Scene
    {
        public int handle = 1;
        public bool isLoaded = true;
        public bool valid = true;
        public List<UnityEngine.GameObject> roots = new List<UnityEngine.GameObject>();
        public int rootCount { get { return roots.Count; } }
        public bool IsValid() { return valid; }
        public void GetRootGameObjects(List<UnityEngine.GameObject> output) { output.AddRange(roots); }
    }
    public static class SceneManager
    {
        public static List<Scene> scenes = new List<Scene>();
        public static int sceneCount { get { return scenes.Count; } }
        public static Scene GetSceneAt(int index) { return scenes[index]; }
    }
}
public static class NativeInventoryHarness
{
    static int checks;
    static void Check(bool result, string message) { checks++; if (!result) throw new Exception(message); }
    static void Awake(CreatorNativeInventory helper) { typeof(CreatorNativeInventory).GetMethod("Awake", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(helper, null); }
    public static void Main(string[] args)
    {
        if (args.Length > 0) { NativeInventoryExportHarness.Run(args); return; }
        var helper = new CreatorNativeInventory(); Awake(helper);
        string json, error;
        Check(!helper.TryCapture(100, 64, 50, out json, out error), "starts disabled");
        Check(!helper.TryApprove("unity-00000000000000000000", false, out error), "no implicit consent");
        Check(!helper.TryApprove("invalid", true, out error), "invalid project rejected");
        UnityEngine.Application.isEditor = true;
        Check(!helper.TryApprove("unity-00000000000000000000", true, out error), "Editor refused");
        UnityEngine.Application.isEditor = false;
        Check(helper.TryApprove("unity-00000000000000000000", true, out error), error);
        string firstSession = helper.SessionId;
        Check(firstSession.Length == 32, "bounded session ID");
        var scene = new UnityEngine.SceneManagement.Scene();
        var root = new UnityEngine.GameObject(1) { renderer = new UnityEngine.Renderer() };
        scene.roots.Add(root);
        var child = new UnityEngine.GameObject(2) { activeSelf = false, activeInHierarchy = false };
        root.transform.children.Add(child.transform);
        UnityEngine.SceneManagement.SceneManager.scenes.Add(scene);
        Check(helper.TryCapture(100, 64, 50, out json, out error), error);
        var doc = JsonDocument.Parse(json);
        Check(doc.RootElement.GetProperty("nodes").GetArrayLength() == 2, "includes inactive child");
        Check(doc.RootElement.GetProperty("nodes")[1].GetProperty("parentId").GetInt32() == 1, "preserves parent identity");
        Check(doc.RootElement.GetProperty("coverage").GetProperty("cameraSubmission").GetString() == "unknown", "visibility not promoted to drawing");
        Check(!child.activeSelf && root.renderer.enabled && scene.roots.Count == 1, "scene unchanged");
        Console.WriteLine("SNAPSHOT:" + json);
        Check(helper.TryCapture(1, 64, 50, out json, out error), error);
        Check(JsonDocument.Parse(json).RootElement.GetProperty("coverage").GetProperty("reason").GetString() == "node-limit", "node limit");
        Check(helper.TryCapture(100, 0, 50, out json, out error), error);
        Check(JsonDocument.Parse(json).RootElement.GetProperty("coverage").GetProperty("reason").GetString() == "depth-limit", "depth limit");
        UnityEngine.GameObject.readDelay = 10;
        Check(helper.TryCapture(100, 64, 1, out json, out error), error);
        Check(JsonDocument.Parse(json).RootElement.GetProperty("coverage").GetProperty("reason").GetString() == "time-limit", "cooperative time limit");
        UnityEngine.GameObject.readDelay = 0;
        Check(!helper.TryCapture(1001, 64, 50, out json, out error), "oversized node request refused");
        bool threadRefused = false;
        var thread = new Thread(() => { string a, b; threadRefused = !helper.TryCapture(100, 64, 50, out a, out b); });
        thread.Start(); thread.Join(); Check(threadRefused, "off-thread capture refused");
        bool revokeRefused = false;
        thread = new Thread(() => { string message; revokeRefused = !helper.TryRevoke(out message); });
        thread.Start(); thread.Join(); Check(revokeRefused && helper.SessionId == firstSession, "off-thread revoke cannot race a capture");
        helper.Revoke();
        Check(!helper.TryCapture(100, 64, 50, out json, out error), "revocation works");
        Check(helper.TryApprove("unity-00000000000000000000", true, out error), error);
        Check(firstSession != helper.SessionId, "fresh session after approval");
        typeof(CreatorNativeInventory).GetMethod("OnDisable", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(helper, null);
        Check(helper.SessionId == null, "disable revokes");
        Check(helper.TryApprove("unity-00000000000000000000", true, out error), error);
        typeof(CreatorNativeInventory).GetMethod("OnApplicationPause", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(helper, new object[] { true });
        Check(helper.SessionId == null, "pause revokes");
        Console.WriteLine("PASS " + checks + " isolated control-flow checks");
    }
}
