using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

public static class CreatorPluginsGridVisual
{
    public static void Open()
    {
        string project = Path.GetDirectoryName(Application.dataPath);
        if (!File.Exists(Path.Combine(project, ".grid-visual-fixture"))) throw new Exception("Refusing a real project.");
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
        bool hadPreference = EditorPrefs.HasKey(CreatorPluginsWindow.LayoutPreference);
        string preference = EditorPrefs.GetString(CreatorPluginsWindow.LayoutPreference, "list");
        EditorApplication.quitting += () => {
            if (hadPreference) EditorPrefs.SetString(CreatorPluginsWindow.LayoutPreference, preference);
            else EditorPrefs.DeleteKey(CreatorPluginsWindow.LayoutPreference);
        };
        var window = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
        var entries = (List<Listing>)typeof(CreatorPluginsWindow).GetField("listings", flags).GetValue(window);
        string json = File.ReadAllText(Path.Combine(project, "listing.json"));
        for (int index = 0; index < 4; index++)
        {
            var entry = JsonUtility.FromJson<Listing>(json);
            entry.id = "fixture.grid." + index; entry.name = "Start Location " + (index + 1);
            if (index == 1) entry.description = "A longer description to check that adjacent cards keep their content inside the available width without overlapping the import and details controls. " + entry.description;
            entry.reviewStatus = "pending";
            entries.Add(entry);
        }
        var texture = new Texture2D(2, 2);
        texture.LoadImage(File.ReadAllBytes(Path.Combine(project, "preview.png")));
        ((Dictionary<string, Texture2D>)typeof(CreatorPluginsWindow).GetField("previews", flags).GetValue(window)).Add(entries[0].previewImage, texture);
        typeof(CreatorPluginsWindow).GetField("gridView", flags).SetValue(window, true);
        window.titleContent = new GUIContent("Plugins Grid Visual Test");
        window.minSize = new Vector2(360, 360);
        window.ShowUtility(); window.position = new Rect(100, 100, 940, 720); window.Focus();
        EditorApplication.update += () => {
            if (File.Exists(Path.Combine(project, ".finish-grid-test"))) EditorApplication.Exit(0);
        };
        File.WriteAllText(Path.Combine(project, "grid-ready.txt"), "Grid fixture ready; import disabled.\n");
    }
}
