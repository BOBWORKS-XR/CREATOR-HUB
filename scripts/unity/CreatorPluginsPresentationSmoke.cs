using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

public static class CreatorPluginsPresentationSmoke
{
    [Serializable] private sealed class Report { public bool passed; public string unity, error; public string[] checks; }
    private static readonly List<string> checks = new List<string>();
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    private static void Check(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
    private static object Call(object instance, string method, params object[] args) => instance.GetType().GetMethod(method, Private).Invoke(instance, args);
    private static T Get<T>(object instance, string field) => (T)instance.GetType().GetField(field, Private).GetValue(instance);
    private static void Set(object instance, string field, object value) => instance.GetType().GetField(field, Private).SetValue(instance, value);
    public static void Run()
    {
        string project = Path.GetDirectoryName(Application.dataPath);
        if (!File.Exists(Path.Combine(project, ".presentation-test-fixture"))) throw new Exception("Refusing a real project.");
        CreatorPluginsWindow window = null;
        bool hadLayout = EditorPrefs.HasKey(CreatorPluginsWindow.LayoutPreference);
        string savedLayout = EditorPrefs.GetString(CreatorPluginsWindow.LayoutPreference, "list");
        var report = new Report { unity = Application.unityVersion };
        try
        {
            Check(CreatorPluginsWindow.Summary(null) == "", "null summary");
            Check(CreatorPluginsWindow.Summary("Short description") == "Short description", "short summary unchanged");
            Check(CreatorPluginsWindow.Summary("Two\nlines") == "Two lines", "multiline summary");
            Check(CreatorPluginsWindow.Summary(new string('x', 400)).Length == 200, "unbroken summary bounded");
            Check(CreatorPluginsWindow.Summary(string.Join(" ", Enumerable.Repeat("description", 50))).EndsWith("..."), "long summary shortened");
            var entry = JsonUtility.FromJson<Listing>(File.ReadAllText(Path.Combine(project, "listing.json")));
            entry.reviewStatus = "listed";
            PluginProtocol.ValidateListing(entry);
            Check(PluginProtocol.CanImport(entry), "listed graph remains importable");
            var paid = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry));
            paid.download = null; paid.scope = "instructions-only";
            var productIndex = new ProductIndex { schemaVersion = 1, products = new[] { new ProductDetails {
                id = paid.id, version = paid.version, purchaseUrl = "https://www.patreon.com/cw/FireRat", websiteUrl = "https://shader.firer.at/",
                claims = new[] { new ProductClaim { dimension = "render-pipeline", value = "URP", evidence = "author-reported", notes = "Not independently tested." } }
            } } };
            var productBytes = Encoding.UTF8.GetBytes(JsonUtility.ToJson(productIndex));
            Check(ProductMetadata.Parse(productBytes, new[] { paid }).Length == 1, "paid exact-version metadata accepted");
            Check(!PluginProtocol.CanImport(paid), "paid external product cannot import");
            Check(ProductMetadata.Parse(productBytes, new[] { entry }).Length == 0, "paid metadata never attaches to package downloads");
            paid.version = "999.0.0";
            Check(ProductMetadata.Parse(productBytes, new[] { paid }).Length == 0, "product version mismatch remains unjoined");
            foreach (string bad in new[] { "http://shader.firer.at/", "https://shader.firer.at.evil.test/", "https://user@shader.firer.at/", "https://127.0.0.1/", "https://shader.firer.at/?redirect=x" })
                Check(!ProductMetadata.ExternalUrl(bad), "external purchase URL refused: " + bad);
            Check(!PluginProtocol.WebUrl("https://shader.firer.at/test.unitypackage"), "purchase hosts do not become download hosts");
            var changed = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry));
            Check(CreatorPluginsWindow.SameDownload(entry, changed), "unchanged identity matches");
            changed.download.sha256 = new string('a', 64);
            Check(!CreatorPluginsWindow.SameDownload(entry, changed), "changed hash refused");
            changed = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry)); changed.version = "9.9.9";
            Check(!CreatorPluginsWindow.SameDownload(entry, changed), "changed version refused");
            changed = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry)); changed.reviewStatus = "pending";
            Check(!PluginProtocol.CanImport(changed), "withdrawn listing not importable");
            changed.category = "ai-skill"; changed.reviewStatus = "listed";
            Check(!PluginProtocol.CanImport(changed), "AI skill does not route into Unity");

            EditorPrefs.DeleteKey(CreatorPluginsWindow.LayoutPreference);
            window = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
            Check(Get<bool>(window, "gridView"), "fresh window defaults to grid");
            Call(window, "StopDownload");
            var mediaBytes = Encoding.UTF8.GetBytes("{\"schemaVersion\":1,\"galleries\":[{\"id\":\"" + entry.id + "\",\"items\":[" + string.Join(",", Enumerable.Range(0, 6).Select(i => "{\"type\":\"image\",\"url\":\"assets/example/" + i + ".png\"}")) + "]}]}");
            var media = PluginProtocol.ParseMedia(mediaBytes);
            Check(media.Length == 1 && media[0].items.Length == 6, "six-image sidecar parsed");
            var galleries = Get<Dictionary<string, PreviewMedia[]>>(window, "galleries");
            entry.previewImage = media[0].items[0].url;
            galleries.Add(entry.id, media[0].items);
            Check(window.GalleryItems(entry).Length == 6, "cover is not duplicated in gallery");
            var animation = new PreviewMedia { type = "webm", url = "assets/example/demo.webm", poster = entry.previewImage };
            Check(PluginProtocol.StaticPreview(animation) == entry.previewImage, "Unity selects WebM static poster");
            animation.type = "gif"; animation.url = "assets/example/demo.gif";
            Check(PluginProtocol.StaticPreview(animation) == entry.previewImage, "Unity selects GIF static poster");
            foreach (string bad in new[] { Encoding.UTF8.GetString(mediaBytes).Replace("assets/example/0.png", "https://evil.test/a.png"), Encoding.UTF8.GetString(mediaBytes).Replace("\"image\"", "\"gif\"") })
            {
                bool rejected = false; try { PluginProtocol.ParseMedia(Encoding.UTF8.GetBytes(bad)); } catch { rejected = true; }
                Check(rejected, "unapproved URL or missing poster refused");
            }
            galleries.Clear();
            Check(window.GalleryItems(entry).Length == 1, "legacy cover works without sidecar");
            Check(CreatorPluginsWindow.GridColumns(330) == 1, "narrow grid has one column");
            Check(CreatorPluginsWindow.GridColumns(540) == 2, "medium grid has two columns");
            Check(CreatorPluginsWindow.GridColumns(810) == 3, "wide grid has three columns");
            Check(CreatorPluginsWindow.GridColumns(0) == 1, "grid always has a column");
            Set(window, "selected", entry); Set(window, "search", "kept search");
            Call(window, "SetLayout", true);
            Check(Get<bool>(window, "gridView") && EditorPrefs.GetString(CreatorPluginsWindow.LayoutPreference) == "grid", "grid selection persisted");
            Check(Get<Listing>(window, "selected") == entry && Get<string>(window, "search") == "kept search", "view switch preserves selected detail and search");
            var reopened = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
            Check(Get<bool>(reopened, "gridView"), "reopened window restores grid");
            UnityEngine.Object.DestroyImmediate(reopened);
            Call(window, "SetLayout", false);
            Check(!Get<bool>(window, "gridView") && EditorPrefs.GetString(CreatorPluginsWindow.LayoutPreference) == "list", "list selection persisted");
            reopened = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
            Check(!Get<bool>(reopened, "gridView"), "explicit list preference survives reopen");
            UnityEngine.Object.DestroyImmediate(reopened);
            var noImage = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry)); noImage.previewImage = "http://unapproved.invalid/image.png";
            Call(window, "RequestPreview", noImage);
            Check(Get<object>(window, "previewRequest") == null, "unapproved preview not fetched");
            Check(Get<object>(window, "request") == null, "thumbnail path independent of action request");
            var source = new Texture2D(1024, 512, TextureFormat.RGBA32, false);
            var thumbnail = (Texture2D)typeof(CreatorPluginsWindow).GetMethod("MakeThumbnail", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { source });
            Check(thumbnail.width == 320 && thumbnail.height == 160, "thumbnail bounded with preserved aspect ratio");
            Check(!thumbnail.isReadable, "thumbnail CPU pixels released");
            UnityEngine.Object.DestroyImmediate(source);
            Get<Dictionary<string, Texture2D>>(window, "previews").Add("fixture", thumbnail);
            Call(window, "ClearPreviews");
            Check(thumbnail == null && Get<Dictionary<string, Texture2D>>(window, "previews").Count == 0, "preview textures disposed");

            Set(window, "catalogueFresh", true); Set(window, "catalogueLoadedAt", EditorApplication.timeSinceStartup - 181);
            Call(window, "Import", entry);
            Check(Get<Listing>(window, "pendingImport") == entry && Get<object>(window, "request") != null, "expired catalogue starts revalidation on explicit import");
            Check(!Directory.Exists(PluginProtocol.Area(project, "inbox")), "revalidation writes no import request");
            Call(window, "CancelDownload");
            Check(Get<Listing>(window, "pendingImport") == null && Get<object>(window, "request") == null, "cancel clears download and deferred import");
            Check(Get<string>(window, "message").Contains("try again"), "cancel offers recovery without reopening");
            Get<List<Listing>>(window, "listings").Add(changed);
            Set(window, "pendingListings", Array.Empty<string>()); Set(window, "pendingImport", entry);
            Set(window, "catalogueDeadline", EditorApplication.timeSinceStartup + 30);
            Call(window, "FinishCatalogue");
            Check(Get<Listing>(window, "pendingImport") == null && Get<string>(window, "message").Contains("No import started"), "withdrawal during revalidation does not import");

            byte[] bytes = Encoding.UTF8.GetBytes("Harmless state-machine test bytes; not an importable archive.");
            entry.download.byteLength = bytes.Length;
            using (var stream = new MemoryStream(bytes)) entry.download.sha256 = PluginProtocol.Hash(stream);
            string file = entry.download.sha256 + ".unitypackage";
            PluginProtocol.SaveNew(project, "packages/" + file, bytes);
            var first = CreatorPluginsWindow.QueueImport(entry, file);
            PluginProtocol.SaveNew(project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(first)));
            ImportReview.Active = first;
            // Callback-state test only: no claim of physically clicking Unity's native dialog.
            typeof(ImportReview).GetMethod("Finished", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { file, "cancelled", "Fixture cancellation callback" });
            Check(ImportReview.Receipt(first).status == "cancelled", "cancellation callback persists final receipt");
            Check(ImportReview.Active == null && !File.Exists(PluginProtocol.Area(project, "active-review.json")), "cancellation releases pending state");
            Get<Dictionary<string, ImportReceipt>>(window, "receipts").Add(first.requestId, new ImportReceipt { requestId = first.requestId, status = "review" });
            Set(window, "nextPoll", EditorApplication.timeSinceStartup + 60);
            Call(window, "Tick");
            Check(Get<Dictionary<string, ImportReceipt>>(window, "receipts")[first.requestId].status == "cancelled", "completion refreshes without waiting for poll timer");
            Check(Get<string>(window, "message").Contains("cancelled"), "cancel replaces outdated import prompt");
            byte[] receiptBefore = File.ReadAllBytes(PluginProtocol.Area(project, "receipts/" + first.requestId + ".json"));
            var instructions = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry));
            instructions.download = null; instructions.scope = "instructions-only";
            PluginProtocol.ValidateListing(instructions);
            Check(!PluginProtocol.CanImport(instructions), "instructions-only listing without download remains valid but not importable");
            Get<List<Listing>>(window, "listings").Clear();
            Get<List<Listing>>(window, "listings").Add(instructions);
            Call(window, "RetryImport", first);
            Check(Get<string>(window, "message").Contains("Refresh the catalogue") && Get<int>(window, "tab") == 0, "retry after download withdrawal returns to catalogue without exception");
            Check(Directory.GetFiles(PluginProtocol.Area(project, "inbox"), "*.json").Length == 1 && ImportReview.Active == null, "withdrawn retry creates no request or import");
            var second = CreatorPluginsWindow.QueueImport(entry, file);
            Check(second.requestId != first.requestId && ImportReview.Receipt(second).status == "queued", "retry has a new queued identity");
            Check(File.Exists(PluginProtocol.Area(project, "history/requests/" + first.requestId + ".json")) && !File.Exists(PluginProtocol.Area(project, "inbox/" + first.requestId + ".json")), "retry archives only the completed request");
            Check(File.ReadAllBytes(PluginProtocol.Area(project, "receipts/" + first.requestId + ".json")).SequenceEqual(receiptBefore), "retry preserves cancellation evidence");
            Check(File.ReadAllBytes(PluginProtocol.Area(project, "packages/" + file)).SequenceEqual(bytes), "retry reuses unchanged cached bytes");
            File.WriteAllBytes(PluginProtocol.Area(project, "packages/" + file), new byte[] { 1, 2, 3 });
            Set(window, "catalogueFresh", true); Set(window, "catalogueLoadedAt", EditorApplication.timeSinceStartup);
            Call(window, "Download", entry);
            Check(Get<string>(window, "message").Contains("did not match"), "corrupted cache rejected before import");
            Check(Directory.GetFiles(PluginProtocol.Area(project, "inbox"), "*.json").Length == 1, "corrupted cache produces no extra request");
            Check(ImportReview.Active == null, "no import or scene operation was started");
            CheckLargeTransfer(entry, project);
            report.passed = true;
        }
        catch (Exception error) { report.error = error.ToString(); Debug.LogException(error); }
        finally
        {
            if (window != null) UnityEngine.Object.DestroyImmediate(window);
            if (hadLayout) EditorPrefs.SetString(CreatorPluginsWindow.LayoutPreference, savedLayout); else EditorPrefs.DeleteKey(CreatorPluginsWindow.LayoutPreference);
            report.checks = checks.ToArray();
            File.WriteAllText(Path.Combine(project, "presentation-result.json"), JsonUtility.ToJson(report, true));
            EditorApplication.Exit(report.passed ? 0 : 1);
        }
    }

    private static void CheckLargeTransfer(Listing source, string project)
    {
        var entry = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(source));
        entry.download = null;
        var listings = new List<Listing> { entry };
        var download = new PackageDownload { url = "https://cdn.sidequestvr.com/file/1/test.unitypackage", byteLength = 93_245_650, sha256 = new string('a', 64) };
        var sidecar = new DownloadIndex { schemaVersion = 1, downloads = new[] { new SupplementalDownload { id = entry.id, version = entry.version, download = download } } };
        PluginProtocol.ApplyDownloads(listings, Encoding.UTF8.GetBytes(JsonUtility.ToJson(sidecar)));
        Check(entry.download.byteLength == 93_245_650 && PluginProtocol.CanImport(entry), "large sidecar enables exact-version Unity import");
        sidecar.downloads[0].download.sha256 = new string('b', 64);
        PluginProtocol.ApplyDownloads(listings, Encoding.UTF8.GetBytes(JsonUtility.ToJson(sidecar)));
        Check(entry.download.sha256 == new string('a', 64), "sidecar cannot overwrite a listed checksum");
        entry.download = null; sidecar.downloads[0].version = "99.0.0";
        PluginProtocol.ApplyDownloads(listings, Encoding.UTF8.GetBytes(JsonUtility.ToJson(sidecar)));
        Check(entry.download == null, "stale sidecar version is not applied");

        const long length = 33L * 1024 * 1024;
        var buffer = new byte[64 * 1024];
        for (int i = 0; i < buffer.Length; i++) buffer[i] = (byte)(i % 251);
        string hash;
        using (var sha = System.Security.Cryptography.SHA256.Create())
        {
            for (long count = 0; count < length; count += buffer.Length) sha.TransformBlock(buffer, 0, buffer.Length, null, 0);
            sha.TransformFinalBlock(new byte[0], 0, 0);
            hash = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
        }
        var cancelled = new CreatorPluginsWindow.DiskDownload(length, hash);
        Check(cancelled.WriteChunk(buffer, buffer.Length), "partial package streams to disk");
        string partial = cancelled.Temporary;
        cancelled.Cleanup(); cancelled.Dispose();
        Check(!File.Exists(partial), "cancel deletes partial package");
        var disk = new CreatorPluginsWindow.DiskDownload(length, hash);
        string temporary = disk.Temporary;
        try
        {
            for (long count = 0; count < length; count += buffer.Length) if (!disk.WriteChunk(buffer, buffer.Length)) throw new Exception("stream chunk rejected");
            Check(true, "33 MiB streamed in bounded chunks");
            var stream = disk.Finish();
            var request = new ImportRequest { requestId = Guid.NewGuid().ToString("N"), projectPath = project, packageId = "fixture.large", version = "1.0.0", name = "Large streaming fixture", byteLength = length, sha256 = hash, packageFile = hash + ".unitypackage" };
            PluginQueue.EnqueueStream(project, request, stream);
            using (PluginProtocol.LockPackage(request, project)) Check(true, "large queued package passes locked streaming verification");
            Check(!Directory.EnumerateFiles(Path.Combine(project, "Assets"), hash + "*", SearchOption.AllDirectories).Any(), "queued package is outside Assets");
            Check(!disk.WriteChunk(buffer, 1), "extra payload byte rejected before write");
        }
        finally { disk.Cleanup(); disk.Dispose(); }
        Check(!File.Exists(temporary), "verified download temporary file removed");
        var bad = new CreatorPluginsWindow.DiskDownload(3, new string('0',64));
        try
        {
            bad.WriteChunk(new byte[] {1,2,3}, 3);
            bool rejected = false; try { bad.Finish(); } catch (InvalidDataException) { rejected = true; }
            Check(rejected, "wrong checksum cannot become an import request");
        }
        finally { bad.Cleanup(); bad.Dispose(); }
    }
}
