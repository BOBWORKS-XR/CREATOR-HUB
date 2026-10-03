using System.Text;
using Unity.VisualScripting;
using UnityEditor;

// Integration-test fixture only; never included in the application payload.
public static class CreatorRepairSeed
{
    public static void AddCustomSelection()
    {
        VSUsageUtility.isVisualScriptingUsed = true;
        var config = BoltCore.Configuration;
        if (!config.typeOptions.Contains(typeof(StringBuilder)))
            config.typeOptions.Add(typeof(StringBuilder));
        config.Save();
        config.SaveProjectSettingsAsset(true);
        EditorApplication.delayCall += () => EditorApplication.Exit(0);
    }
}
