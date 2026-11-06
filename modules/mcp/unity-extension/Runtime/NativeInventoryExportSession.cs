using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;

namespace CreatorWorks.Diagnostics
{
    // Same-machine file transport. Call only after native host UI approval.
    // It creates diagnostic files in a new session directory, never settings or assets.
    internal sealed class NativeInventoryExportSession
    {
        private readonly string root, directory, projectId, sessionId, buildGuid;
        private readonly int leaseSeconds;
        private string snapshotHash, receiptHash;
        private bool closed;
        private bool cleanupComplete, revocationVerified;
        private long lastLeaseExpiry;
        public string DirectoryPath { get { return directory; } }
        public bool RevocationVerified { get { return revocationVerified; } }
        public bool LeaseExpired { get { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > lastLeaseExpiry + 5000; } }

        private NativeInventoryExportSession(string projectRoot, string approvedProjectId, string approvedSessionId, int seconds)
        {
            string fullPath = Path.GetFullPath(projectRoot);
            root = fullPath.Length == Path.GetPathRoot(fullPath).Length ? fullPath :
                fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            projectId = approvedProjectId; sessionId = approvedSessionId; buildGuid = Application.buildGUID;
            leaseSeconds = seconds;
            directory = Path.Combine(root, ".bantworks-mcp", "native-inventory", sessionId);
        }

        public static bool TryOpen(string projectRoot, string projectId, string sessionId, int leaseSeconds,
            out NativeInventoryExportSession session, out string error)
        {
            session = null; error = null;
            try
            {
                if (string.IsNullOrWhiteSpace(projectRoot) || !Path.IsPathFullyQualified(projectRoot) || projectRoot.Length > 4096 ||
                    leaseSeconds < 1 || leaseSeconds > 300) throw new ExportGuardException("Invalid approved export directory or lease duration.");
                var candidate = new NativeInventoryExportSession(projectRoot, projectId, sessionId, leaseSeconds);
                candidate.CheckProject();
                var parent = Path.GetDirectoryName(candidate.directory);
                candidate.CreateOrdinaryDirectory(Path.Combine(candidate.root, ".bantworks-mcp"));
                candidate.CreateOrdinaryDirectory(parent);
                if (File.Exists(candidate.directory) || Directory.Exists(candidate.directory))
                    throw new ExportGuardException("Native inventory session directory already exists.");
                Directory.CreateDirectory(candidate.directory);
                candidate.CheckDirectory();
                candidate.WriteReceipt("active", "", "");
                session = candidate;
                return true;
            }
            catch (Exception ex) { error = "Native export was not enabled: " + Reason(ex); return false; }
        }

        public bool TryPublish(string json, out string error)
        {
            error = null;
            string stage = "validate";
            try
            {
                if (closed) throw new ExportGuardException("Session is closed.");
                CheckDirectory();
                AssertOwned("session.json", receiptHash);
                AssertOwned("snapshot.json", snapshotHash);
                var bytes = Encoding.UTF8.GetBytes(json ?? "");
                if (bytes.Length == 0 || bytes.Length > 1024 * 1024) throw new ExportGuardException("Invalid snapshot size.");
                var envelope = JsonUtility.FromJson<Envelope>(json);
                if (envelope == null || envelope.capture == null || envelope.producer == null ||
                    envelope.capture.projectId != projectId || envelope.capture.sessionId != sessionId ||
                    envelope.producer.buildGuid != buildGuid || string.IsNullOrEmpty(envelope.capture.snapshotId))
                    throw new ExportGuardException("Snapshot identity differs from the approved session.");
                var nextHash = Digest(bytes);
                stage = "write snapshot";
                WriteOwned("snapshot.json", bytes, ref snapshotHash);
                stage = "commit receipt";
                WriteReceipt("active", envelope.capture.snapshotId, nextHash);
                return true;
            }
            catch (Exception ex) { error = "Native snapshot was not published (" + stage + "): " + Reason(ex); return false; }
        }

        public bool TryClose(out string error)
        {
            error = null;
            if (cleanupComplete) return true;
            closed = true;
            try
            {
                CheckDirectory();
                // Withdraw the lease before deleting the snapshot. Readers fail closed during cleanup.
                if (!revocationVerified) { WriteReceipt("revoked", "", ""); revocationVerified = true; }
                var file = Path.Combine(directory, "snapshot.json");
                if (snapshotHash != null && File.Exists(file))
                {
                    CheckFile(file);
                    if (ReadDigest(file, 1024 * 1024) != snapshotHash) throw new ExportGuardException("Snapshot ownership changed.");
                    File.Delete(file);
                }
                cleanupComplete = true;
                return true;
            }
            catch (Exception ex)
            {
                error = "Approval ended but export cleanup could not be verified; the last lease will expire: " + Reason(ex);
                return false;
            }
        }

        private void WriteReceipt(string state, string snapshotId, string hash)
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var receipt = new Receipt { projectId = projectId, sessionId = sessionId, buildGuid = buildGuid,
                state = state, issuedAtUnixMs = now, expiresAtUnixMs = state == "active" ? now + leaseSeconds * 1000L : now,
                snapshotId = snapshotId, snapshotSha256 = hash };
            WriteOwned("session.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(receipt)), ref receiptHash);
            if (state == "active") lastLeaseExpiry = receipt.expiresAtUnixMs;
        }

        private void WriteOwned(string name, byte[] bytes, ref string previousHash)
        {
            CheckDirectory();
            string file = Path.Combine(directory, name);
            AssertOwned(name, previousHash);
            string temporary = Path.Combine(directory, ".write-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                CheckDirectory();
                AssertOwned(name, previousHash);
                if (previousHash == null) File.Move(temporary, file);
                else ReplaceDiagnostic(temporary, file);
                previousHash = Digest(bytes);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static void ReplaceDiagnostic(string temporary, string file)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) { File.Replace(temporary, file, null); return; }
            // Same-directory diagnostics need rename replacement, not ReplaceFile's metadata merge.
            // No copy/delete fallback: a locked destination must stay intact and report failure.
            if (!MoveFileExW(ExtendedWindowsPath(temporary), ExtendedWindowsPath(file), 1))
                throw new IOException("Diagnostic rename replacement failed.", unchecked((int)0x80070000) | Marshal.GetLastWin32Error());
        }

        private static string ExtendedWindowsPath(string value) => value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value :
            value.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + value.Substring(2) : @"\\?\" + value;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileExW(string existingFile, string newFile, int flags);

        private void AssertOwned(string name, string previousHash)
        {
            string file = Path.Combine(directory, name);
            if (File.Exists(file))
            {
                CheckFile(file);
                if (previousHash == null || ReadDigest(file, 1024 * 1024) != previousHash)
                    throw new ExportGuardException("Diagnostic file ownership changed.");
            }
            else if (previousHash != null) throw new ExportGuardException("Owned diagnostic file disappeared.");
        }

        private void CheckProject()
        {
            CheckOrdinaryDirectory(root);
            CheckOrdinaryDirectory(Path.Combine(root, "Assets"));
            CheckOrdinaryDirectory(Path.Combine(root, "ProjectSettings"));
            var version = Path.Combine(root, "ProjectSettings", "ProjectVersion.txt");
            CheckFile(version);
            using (var stream = new FileStream(version, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length > 8192) throw new ExportGuardException("Invalid Unity project descriptor.");
                var buffer = new byte[8193];
                int length = 0, count;
                while (length < buffer.Length && (count = stream.Read(buffer, length, buffer.Length - length)) > 0) length += count;
                if (length > 8192 || !Regex.IsMatch(Encoding.UTF8.GetString(buffer, 0, length), "^m_EditorVersion: [0-9]+\\.[0-9]+\\.[0-9]+[abfp][0-9]+\\s*$", RegexOptions.Multiline))
                    throw new ExportGuardException("Invalid Unity project descriptor.");
            }
        }
        private void CheckDirectory()
        {
            CheckProject();
            CheckOrdinaryDirectory(Path.Combine(root, ".bantworks-mcp"));
            CheckOrdinaryDirectory(Path.Combine(root, ".bantworks-mcp", "native-inventory"));
            CheckOrdinaryDirectory(directory);
        }
        private void CreateOrdinaryDirectory(string path)
        {
            try { CheckOrdinaryDirectory(path); return; }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            Directory.CreateDirectory(path);
            CheckOrdinaryDirectory(path);
        }
        private static void CheckOrdinaryDirectory(string path)
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
                throw new ExportGuardException("Directory must not be linked.");
        }
        private static void CheckFile(string path)
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new ExportGuardException("File must be ordinary and unlinked.");
        }
        private static string ReadDigest(string path, long maxBytes)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length > maxBytes) throw new ExportGuardException("Diagnostic file is oversized.");
                using (var sha = SHA256.Create())
                {
                    long total = 0;
                    var buffer = new byte[8192];
                    int count;
                    while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        total += count;
                        if (total > maxBytes) throw new ExportGuardException("Diagnostic file grew past its bound.");
                        sha.TransformBlock(buffer, 0, count, buffer, 0);
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    return Hex(sha.Hash);
                }
            }
        }
        private static string Digest(byte[] bytes) { using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(bytes)); }
        private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
        private sealed class ExportGuardException : IOException
        {
            public ExportGuardException(string message) : base(message) { }
        }
        private static string Reason(Exception error) => error is ExportGuardException ? error.Message :
            error.GetType().Name + " (0x" + error.HResult.ToString("X8") + ")";
        [Serializable] private sealed class Receipt
        {
            public int schemaVersion = 1;
            public string projectId, sessionId, buildGuid, state, snapshotId, snapshotSha256;
            public long issuedAtUnixMs, expiresAtUnixMs;
        }
        [Serializable] private sealed class Envelope { public Identity capture; public Producer producer; }
        [Serializable] private sealed class Identity { public string projectId, sessionId, snapshotId; }
        [Serializable] private sealed class Producer { public string buildGuid; }
    }
}
