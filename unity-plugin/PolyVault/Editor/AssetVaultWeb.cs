using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace AssetVault.EditorTools
{
    /// <summary>
    /// Minimal async HTTP for editor scripts. Requests are driven by
    /// <see cref="EditorApplication.update"/> so they complete on the main thread
    /// without blocking the UI.
    ///
    /// Every request carries the configured access token, so the same code works
    /// against a local desktop app (no token) and a shared Poly Vault server.
    /// </summary>
    public static class AssetVaultWeb
    {
        // Callback(ok, textOrError). "ok" == HTTP success, "textOrError" is the
        // response body on success or the web request error string on failure.
        private sealed class Pending
        {
            public UnityWebRequest Request;
            public Action<bool, string> Callback;
            public bool IsFileDownload;
        }

        private static readonly List<Pending> PendingRequests = new List<Pending>();
        private static bool _hooked;

        public static bool HasToken => !string.IsNullOrEmpty(AssetVaultSettings.Token);

        private static void EnsureHooked()
        {
            if (_hooked) return;
            _hooked = true;
            EditorApplication.update -= Tick;
            EditorApplication.update += Tick;
        }

        private static void ApplyHeaders(UnityWebRequest req)
        {
            string token = AssetVaultSettings.Token;
            if (!string.IsNullOrEmpty(token))
                req.SetRequestHeader("Authorization", "Bearer " + token);
        }

        public static void GetJson(string url, Action<bool, string> done)
        {
            var req = UnityWebRequest.Get(url);
            req.timeout = 20;
            ApplyHeaders(req);
            Start(req, done);
        }

        public static void PostJson(string url, string jsonBody, Action<bool, string> done)
        {
            var req = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST);
            var bytes = System.Text.Encoding.UTF8.GetBytes(jsonBody);
            req.uploadHandler = new UploadHandlerRaw(bytes);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.timeout = 20;
            ApplyHeaders(req);
            Start(req, done);
        }

        /// <summary>
        /// Streams a server file to <paramref name="destPath"/>. Used when the
        /// asset lives on a shared Poly Vault server instead of the local disk.
        /// </summary>
        public static void DownloadFile(string url, string destPath, Action<bool, string> done)
        {
            try
            {
                string dir = System.IO.Path.GetDirectoryName(destPath);
                if (!string.IsNullOrEmpty(dir) && !System.IO.Directory.Exists(dir))
                    System.IO.Directory.CreateDirectory(dir);
                // DownloadHandlerFile appends/overwrites inconsistently across
                // Unity versions when the target exists; start from a clean file.
                if (System.IO.File.Exists(destPath)) System.IO.File.Delete(destPath);
            }
            catch (Exception e)
            {
                done?.Invoke(false, "Could not create download folder: " + e.Message);
                return;
            }

            var req = UnityWebRequest.Get(url);
            // 0 = no timeout: asset packs can be large on a slow share.
            req.timeout = 0;
            req.downloadHandler = new DownloadHandlerFile(destPath);
            ApplyHeaders(req);
            EnsureHooked();
            req.SendWebRequest();
            PendingRequests.Add(new Pending { Request = req, Callback = done, IsFileDownload = true });
        }

        private static void Start(UnityWebRequest req, Action<bool, string> done)
        {
            EnsureHooked();
            req.SendWebRequest();
            PendingRequests.Add(new Pending { Request = req, Callback = done });
        }

        private static void Tick()
        {
            if (PendingRequests.Count == 0) return;
            for (int i = PendingRequests.Count - 1; i >= 0; i--)
            {
                var p = PendingRequests[i];
                if (!p.Request.isDone) continue;

                bool ok = p.Request.result == UnityWebRequest.Result.Success;
                string textOrError;
                if (!ok)
                {
                    textOrError = p.Request.responseCode == 401
                        ? "401 Unauthorized - check the access token in Window > Poly Vault"
                        : (p.Request.error ?? "Request failed");
                }
                else if (p.IsFileDownload)
                {
                    textOrError = string.Empty;
                }
                else
                {
                    var buffer = p.Request.downloadHandler as DownloadHandlerBuffer;
                    textOrError = buffer != null ? buffer.text : string.Empty;
                }

                PendingRequests.RemoveAt(i);
                try
                {
                    p.Callback?.Invoke(ok, textOrError);
                }
                catch (Exception e)
                {
                    Debug.LogError($"[Poly Vault] callback threw: {e}");
                }
                p.Request.Dispose();
            }
        }
    }
}
