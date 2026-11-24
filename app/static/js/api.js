/* ============================================================
   KAGGLE CLOUD DRIVE - API CLIENT LAYER
   ============================================================ */

const API = {
  async request(endpoint, options = {}) {
    const defaultHeaders = {};
    if (options.body && !(options.body instanceof FormData)) {
      defaultHeaders["Content-Type"] = "application/json";
    }

    const config = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    };

    try {
      const response = await fetch(endpoint, config);

      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent("auth:unauthorized"));
        throw new Error("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.");
      }

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const detail = data.detail;
        const errorMsg = (typeof detail === "string" ? detail : detail && detail.message)
          || data.message
          || `L\u1ed7i m\u00e1y ch\u1ee7 (${response.status})`;
        const error = new Error(errorMsg);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (err) {
      throw err;
    }
  },

  // Auth Endpoints
  login(username, password) {
    return this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
  },

  logout() {
    return this.request("/api/auth/logout", { method: "POST" });
  },

  getMe() {
    return this.request("/api/auth/me");
  },

  // File Endpoints
  listFiles(path = "", showHidden = false) {
    const params = new URLSearchParams({ path, show_hidden: showHidden });
    return this.request(`/api/files?${params.toString()}`);
  },

  getFileContent(path) {
    return this.request("/api/files/content?path=" + encodeURIComponent(path));
  },

  saveFileContent(path, content, encoding = "utf-8", newline = "\n") {
    return this.request("/api/files/content", {
      method: "POST",
      body: JSON.stringify({ path, content, encoding, newline })
    });
  },

  saveBinaryFile(path, content_b64) {
    return this.request("/api/files/save-binary", {
      method: "POST",
      body: JSON.stringify({ path, content_b64 })
    });
  },

  checkUploadConflicts(target_path, relative_paths) {
    return this.request("/api/files/upload/check", {
      method: "POST",
      body: JSON.stringify({ target_path, relative_paths })
    });
  },

  cancelUploadChunks(target_path, uploads) {
    return this.request("/api/files/upload/cancel", {
      method: "POST",
      body: JSON.stringify({ target_path, uploads })
    });
  },

  createFolder(path) {
    return this.request("/api/files/mkdir", {
      method: "POST",
      body: JSON.stringify({ path })
    });
  },

  createFile(path) {
    return this.request("/api/files/touch", {
      method: "POST",
      body: JSON.stringify({ path })
    });
  },

  deleteItem(path) {
    return this.request("/api/files/delete", {
      method: "DELETE",
      body: JSON.stringify({ path })
    });
  },

  startFileOperation(operation, payload = {}) {
    return this.request("/api/files/operations", {
      method: "POST",
      body: JSON.stringify({ ...payload, operation })
    });
  },

  getFileOperation(operationId) {
    return this.request("/api/files/operations/" + encodeURIComponent(operationId));
  },

  cancelFileOperation(operationId) {
    return this.request("/api/files/operations/" + encodeURIComponent(operationId), {
      method: "DELETE"
    });
  },

  downloadFileOperationZip(operationId, filename = "selected_items.zip") {
    const params = new URLSearchParams({ filename });
    const anchor = document.createElement("a");
    anchor.href = "/api/files/operations/" + encodeURIComponent(operationId) +
      "/download?" + params.toString();
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  },

  renameItem(path, new_name) {
    return this.request("/api/files/rename", {
      method: "POST",
      body: JSON.stringify({ path, new_name })
    });
  },

  copyItem(source_path, target_folder) {
    return this.request("/api/files/copy", {
      method: "POST",
      body: JSON.stringify({ source_path, target_folder })
    });
  },

  moveItem(source_path, target_folder) {
    return this.request("/api/files/move", {
      method: "POST",
      body: JSON.stringify({ source_path, target_folder })
    });
  },

  extractArchive(path, target_folder = null, overwrite = false, overwrite_paths = [], skip_paths = []) {
    return this.request("/api/files/extract", {
      method: "POST",
      body: JSON.stringify({ path, target_folder, overwrite, overwrite_paths, skip_paths })
    });
  },

  compressItems(paths, archive_name = null, target_folder = null) {
    return this.request("/api/files/compress", {
      method: "POST",
      body: JSON.stringify({ paths, archive_name, target_folder })
    });
  },

  downloadFromUrl(url, target_folder = "", filename = null, overwrite = false) {
    return this.request("/api/files/download-from-url", {
      method: "POST",
      body: JSON.stringify({ url, target_folder, filename, overwrite })
    });
  },

  async downloadSelectedZip(items) {
    const response = await fetch("/api/files/download-selected-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    });
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent("auth:unauthorized"));
      throw new Error("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.");
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || "Không thể tải tệp nén");
    }
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = "selected_items.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 5000);
  },

  // System Endpoints
  getSystemStats() {
    return this.request("/api/system/stats");
  },

  getListeningPorts() {
    return this.request("/api/system/ports");
  },

  startPortTunnel(port) {
    return this.request("/api/system/ports/" + encodeURIComponent(port) + "/tunnel", { method: "POST" });
  },

  closeLocalPort(port) {
    return this.request("/api/system/ports/" + encodeURIComponent(port), { method: "DELETE" });
  },

  stopPortTunnel(port) {
    return this.request("/api/system/ports/" + encodeURIComponent(port) + "/tunnel", { method: "DELETE" });
  },

  closeTerminalSession(sessionId) {
    return this.request("/api/system/terminal/" + encodeURIComponent(sessionId), { method: "DELETE" });
  }
};

