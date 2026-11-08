using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace AssetVault.EditorTools
{
    /// <summary>
    /// Imports a completed ImportJobDto into the current project's Assets folder.
    /// .unitypackage files are opened through Unity's own import dialog; all other
    /// importable files are copied under Assets/PolyVaultImports/...
    /// </summary>
    [InitializeOnLoad]
    public static class AssetVaultImporter
    {
        public const string ImportRoot = "Assets/PolyVaultImports";

        private static readonly HashSet<string> InFlight = new HashSet<string>();
        private static readonly Dictionary<string, ImportJobDto> PendingPackageJobs =
            new Dictionary<string, ImportJobDto>(StringComparer.OrdinalIgnoreCase);

        static AssetVaultImporter()
        {
            AssetDatabase.importPackageCompleted += OnPackageImportCompleted;
            AssetDatabase.importPackageCancelled += OnPackageImportCancelled;
            AssetDatabase.importPackageFailed += OnPackageImportFailed;
        }

        public static bool IsInFlight(string jobId) => !string.IsNullOrEmpty(jobId) && InFlight.Contains(jobId);

        public static void CancelInFlight(string jobId)
        {
            if (string.IsNullOrEmpty(jobId)) return;
            InFlight.Remove(jobId);
            var keys = new List<string>();
            foreach (var kvp in PendingPackageJobs)
            {
                if (kvp.Value != null && kvp.Value.id == jobId) keys.Add(kvp.Key);
            }
            foreach (var k in keys) PendingPackageJobs.Remove(k);
        }

        private static void RegisterPendingPackage(ImportableDto item, ImportJobDto job)
        {
            if (item == null || job == null) return;
            string key1 = Path.GetFileNameWithoutExtension(item.path);
            if (!string.IsNullOrEmpty(key1)) PendingPackageJobs[key1] = job;
            if (!string.IsNullOrEmpty(item.name))
            {
                PendingPackageJobs[item.name] = job;
                string key2 = Path.GetFileNameWithoutExtension(item.name);
                if (!string.IsNullOrEmpty(key2)) PendingPackageJobs[key2] = job;
            }
        }

        private static bool TryPopPackageJob(string packageName, out ImportJobDto job)
        {
            job = null;
            if (PendingPackageJobs.Count == 0) return false;

            if (!string.IsNullOrEmpty(packageName))
            {
                if (PendingPackageJobs.TryGetValue(packageName, out job))
                {
                    RemoveJobFromPending(job);
                    InFlight.Remove(job.id);
                    return true;
                }
                string clean = Path.GetFileNameWithoutExtension(packageName);
                if (PendingPackageJobs.TryGetValue(clean, out job))
                {
                    RemoveJobFromPending(job);
                    InFlight.Remove(job.id);
                    return true;
                }
            }

            if (PendingPackageJobs.Count >= 1)
            {
                using (var enumerator = PendingPackageJobs.Values.GetEnumerator())
                {
                    if (enumerator.MoveNext())
                    {
                        job = enumerator.Current;
                        RemoveJobFromPending(job);
                        InFlight.Remove(job.id);
                        return true;
                    }
                }
            }

            return false;
        }

        private static void RemoveJobFromPending(ImportJobDto job)
        {
            if (job == null) return;
            var keys = new List<string>();
            foreach (var kvp in PendingPackageJobs)
            {
                if (kvp.Value != null && kvp.Value.id == job.id) keys.Add(kvp.Key);
            }
            foreach (var k in keys) PendingPackageJobs.Remove(k);
        }

        private static void OnPackageImportCompleted(string packageName)
        {
            if (TryPopPackageJob(packageName, out var job))
            {
                Debug.Log($"[Poly Vault] Package '{packageName}' imported successfully.");
                ReportJobResult(job, true, $"Imported package {packageName}.");
                CleanupCache(job);
                AssetVaultQueue.PollNow();
            }
        }

        private static void OnPackageImportCancelled(string packageName)
        {
            if (TryPopPackageJob(packageName, out var job))
            {
                Debug.LogWarning($"[Poly Vault] Package '{packageName}' import was cancelled in Unity.");
                ReportJobResult(job, false, $"Package '{packageName}' import cancelled in Unity.");
                CleanupCache(job);
                AssetVaultQueue.PollNow();
            }
        }

        private static void OnPackageImportFailed(string packageName, string errorMessage)
        {
            if (TryPopPackageJob(packageName, out var job))
            {
                Debug.LogError($"[Poly Vault] Package '{packageName}' import failed: {errorMessage}");
                ReportJobResult(job, false, $"Package '{packageName}' import failed: {errorMessage}");
                CleanupCache(job);
                AssetVaultQueue.PollNow();
            }
        }

        private static string Sanitize(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unknown";
            char[] invalid = Path.GetInvalidFileNameChars();
            char[] trimmed = new char[name.Length];
            for (int i = 0; i < name.Length; i++)
            {
                trimmed[i] = Array.IndexOf(invalid, name[i]) >= 0 ? '_' : name[i];
            }
            string result = new string(trimmed).Trim(' ', '.');
            return result.Length == 0 ? "unknown" : result;
        }

        private static string UniqueFile(string dest)
        {
            if (!File.Exists(dest)) return dest;

            string dir = Path.GetDirectoryName(dest);
            string filename = Path.GetFileNameWithoutExtension(dest);
            string ext = Path.GetExtension(dest);
            for (int i = 1; i < 1000; i++)
            {
                string candidate = Path.Combine(dir, $"{filename} ({i}){ext}");
                if (!File.Exists(candidate)) return candidate;
            }
            return dest;
        }

        private static string DestinationFor(ImportJobDto job, ImportableDto item)
        {
            string folder =
                Path.Combine(ImportRoot.Replace('/', Path.DirectorySeparatorChar),
                    Sanitize(job.libraryName),
                    Sanitize(job.category),
                    Sanitize(job.assetName));

            string rel = string.IsNullOrEmpty(item.rel)
                ? item.name
                : item.rel.Replace('/', Path.DirectorySeparatorChar);

            // Guard against nav-out via malicious rel paths.
            string combined = Path.GetFullPath(Path.Combine(folder, rel));
            string root = Path.GetFullPath(folder);
            if (!combined.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                combined = Path.Combine(folder, item.name);

            return combined;
        }

        /// <summary>
        /// Resolves every importable to a local file, downloading it from the Poly
        /// Vault server when the library lives on a remote host, then imports.
        /// </summary>
        /// <returns>true if the job was accepted (started or completed).</returns>
        public static bool TryImport(ImportJobDto job, bool interactive, Action<string> log, Action<string, bool> finished)
        {
            if (job == null || string.IsNullOrEmpty(job.id))
            {
                finished?.Invoke("Job has no id", false);
                return false;
            }
            if (IsInFlight(job.id))
            {
                log?.Invoke($"Job {job.assetName} is already being imported.");
                return false;
            }

            InFlight.Add(job.id);
            try
            {
                var resolved = new List<ResolvedItem>();
                foreach (var item in job.importables)
                {
                    if (item == null) continue;

                    if (!string.IsNullOrEmpty(item.entry))
                    {
                        // One file from inside a package: always fetched from the
                        // server, which extracts it from the archive.
                        if (AssetVaultSettings.UsesRemoteServer)
                        {
                            resolved.Add(new ResolvedItem { Item = item, LocalPath = CachePathFor(job, item) });
                        }
                        else
                        {
                            log?.Invoke($"{item.name}: importing files from inside a package needs the Poly Vault web server.");
                        }
                        continue;
                    }

                    if (!string.IsNullOrEmpty(item.path) && File.Exists(item.path))
                    {
                        // Desktop app (or a shared mount): the file is already local.
                        resolved.Add(new ResolvedItem { Item = item, LocalPath = item.path });
                    }
                    else if (AssetVaultSettings.UsesRemoteServer)
                    {
                        // Shared web server: fetch it over HTTP into the project cache.
                        resolved.Add(new ResolvedItem { Item = item, LocalPath = CachePathFor(job, item) });
                    }
                    else
                    {
                        log?.Invoke($"Missing file: {item.path}");
                    }
                }

                bool needsDownload = false;
                foreach (var entry in resolved)
                {
                    if (!File.Exists(entry.LocalPath)) { needsDownload = true; break; }
                }

                if (!needsDownload)
                {
                    ImportResolved(job, resolved, interactive, log, finished);
                    return true;
                }

                DownloadThenImport(job, resolved, 0, interactive, log, finished);
                return true;
            }
            catch (Exception e)
            {
                InFlight.Remove(job.id);
                string msg = e.Message;
                log?.Invoke($"Import failed: {msg}");
                ReportJobResult(job, false, msg);
                finished?.Invoke($"Import failed: {msg}", false);
                return true;
            }
        }

        private sealed class ResolvedItem
        {
            public ImportableDto Item;
            public string LocalPath;
        }

        private static string CacheDirFor(ImportJobDto job) =>
            Path.Combine("Library", "PolyVaultCache", Sanitize(job.id));

        private static string CachePathFor(ImportJobDto job, ImportableDto item)
        {
            string rel = string.IsNullOrEmpty(item.rel) ? item.name : item.rel;
            string root = Path.GetFullPath(CacheDirFor(job));
            string combined = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
            if (!combined.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                combined = Path.Combine(root, Sanitize(item.name));
            return combined;
        }

        private static string DownloadUrlFor(ImportableDto item)
        {
            string url = $"{AssetVaultSettings.ServerUrl}/api/file?path={UnityWebRequest.EscapeURL(item.path)}";
            // A file inside a .unitypackage: the server extracts it on demand.
            if (!string.IsNullOrEmpty(item.entry))
                url += $"&entry={UnityWebRequest.EscapeURL(item.entry)}";
            return url;
        }

        /// <summary>
        /// Downloads the still-missing files one at a time, then imports. Sequential
        /// on purpose: keeps the editor responsive and is kind to the server.
        /// </summary>
        private static void DownloadThenImport(ImportJobDto job, List<ResolvedItem> resolved, int index,
            bool interactive, Action<string> log, Action<string, bool> finished)
        {
            while (index < resolved.Count && File.Exists(resolved[index].LocalPath)) index++;
            if (index >= resolved.Count)
            {
                ImportResolved(job, resolved, interactive, log, finished);
                return;
            }

            var entry = resolved[index];
            log?.Invoke($"Downloading {entry.Item.name} ({index + 1}/{resolved.Count})...");
            ReportJobStatus(job, "processing", $"Downloading {entry.Item.name}");

            AssetVaultWeb.DownloadFile(DownloadUrlFor(entry.Item), entry.LocalPath, (ok, error) =>
            {
                if (!ok)
                {
                    InFlight.Remove(job.id);
                    log?.Invoke($"Download failed for {entry.Item.name}: {error}");
                    ReportJobResult(job, false, $"Download failed for {entry.Item.name}: {error}");
                    finished?.Invoke($"Download failed: {error}", false);
                    return;
                }

                try
                {
                    DownloadThenImport(job, resolved, index + 1, interactive, log, finished);
                }
                catch (Exception e)
                {
                    InFlight.Remove(job.id);
                    log?.Invoke($"Import failed: {e.Message}");
                    ReportJobResult(job, false, e.Message);
                    finished?.Invoke($"Import failed: {e.Message}", false);
                }
            });
        }

        private static void ImportResolved(ImportJobDto job, List<ResolvedItem> resolved, bool interactive,
            Action<string> log, Action<string, bool> finished)
        {
            int imported = 0;
            int skippedPackages = 0;
            bool hasInteractivePackage = false;

            string destAssetRoot = Path.Combine(
                ImportRoot.Replace('/', Path.DirectorySeparatorChar),
                Sanitize(job.libraryName),
                Sanitize(job.category),
                Sanitize(job.assetName));

            foreach (var entry in resolved)
            {
                var item = entry.Item;
                if (item == null) continue;

                if (string.Equals(item.kind, "unitypackage", StringComparison.OrdinalIgnoreCase))
                {
                    if (!File.Exists(entry.LocalPath))
                    {
                        log?.Invoke($"Missing file: {item.name}");
                        continue;
                    }
                    if (interactive)
                    {
                        hasInteractivePackage = true;
                        RegisterPendingPackage(item, job);
                        ReportJobStatus(job, "processing", $"Importing package {item.name} in Unity...");
                        AssetDatabase.ImportPackage(entry.LocalPath, true);
                        log?.Invoke($"Opened package import for {item.name}");
                        imported++;
                    }
                    else
                    {
                        skippedPackages++;
                        log?.Invoke($"Skipped {item.name} (unitypackage needs manual import from the window).");
                    }
                    continue;
                }

                if (!File.Exists(entry.LocalPath))
                {
                    log?.Invoke($"Missing file: {item.name}");
                    continue;
                }

                string dest = UniqueFile(DestinationFor(job, item));
                string destDir = Path.GetDirectoryName(dest);
                if (!Directory.Exists(destDir)) Directory.CreateDirectory(destDir);

                try
                {
                    File.Copy(entry.LocalPath, dest, overwrite: false);
                    imported++;
                    log?.Invoke($"Copied {item.name} -> {dest.Replace(Path.DirectorySeparatorChar, '/')}");
                }
                catch (Exception e)
                {
                    log?.Invoke($"Copy failed for {item.name}: {e.Message}");
                }
            }

            AssetDatabase.Refresh();
            WriteTagsFile(destAssetRoot, job.tags);

            // Unity's package dialog reads the file after ImportPackage returns,
            // so the cache survives until the pending import completes.
            if (!hasInteractivePackage) CleanupCache(job);

            if (hasInteractivePackage)
            {
                finished?.Invoke($"Opened package import dialog for {job.assetName}.", true);
                return;
            }

            if (imported == 0 && skippedPackages > 0)
            {
                finished?.Invoke("Only unitypackage files pending manual import.", false);
                InFlight.Remove(job.id);
                return;
            }

            InFlight.Remove(job.id);
            ReportJobResult(job, true, $"Imported {imported} file(s).");
            finished?.Invoke($"Imported {imported} file(s).", true);
        }

        /// <summary>Removes this job's downloaded copies from the project cache; best effort.</summary>
        private static void CleanupCache(ImportJobDto job)
        {
            try
            {
                string dir = CacheDirFor(job);
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Poly Vault] Could not clean download cache: {e.Message}");
            }
        }

        /// <summary>
        /// Writes the source tags next to the imported asset so the information
        /// survives inside the project (Assets/.../polyvault.tags.json).
        /// </summary>
        private static void WriteTagsFile(string destAssetRoot, List<string> tags)
        {
            if (tags == null || tags.Count == 0) return;
            try
            {
                if (!Directory.Exists(destAssetRoot)) return;
                var sb = new System.Text.StringBuilder("{\"tags\":[");
                for (int i = 0; i < tags.Count; i++)
                {
                    if (i > 0) sb.Append(",");
                    sb.Append(JsonString(tags[i]));
                }
                sb.Append("]}");
                File.WriteAllText(Path.Combine(destAssetRoot, "polyvault.tags.json"), sb.ToString());
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Poly Vault] Could not write tags file: {e.Message}");
            }
        }

        private static string JsonString(string s)
        {
            if (string.IsNullOrEmpty(s)) return "\"\"";
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        public static void ReportJobStatus(ImportJobDto job, string status, string note)
        {
            if (job == null || string.IsNullOrEmpty(job.id)) return;
            string url = $"{AssetVaultSettings.ServerUrl}/api/unity/import-jobs/{job.id}/{status}";
            string body = "{\"note\":" + JsonUtility.ToJson(note) + "}";
            AssetVaultWeb.PostJson(url, body, (ok, text) =>
            {
                if (!ok) Debug.LogWarning($"[Poly Vault] Failed to report job status to server: {text}");
            });
        }

        /// <summary>
        /// Reports a job as imported or failed back to the Poly Vault server so
        /// it leaves the pending queue. Best effort; async.
        /// </summary>
        public static void ReportJobResult(ImportJobDto job, bool success, string note)
        {
            ReportJobStatus(job, success ? "complete" : "failed", note);
        }
    }
}