/* ============================================================
   KAGGLE CLOUD DRIVE - API CLIENT LAYER
   ============================================================ */

const API = {
  withFileScope(endpoint, fileScope = null) {
    if (!endpoint.startsWith("/api/files")) {
      return endpoint;
    }
    const url = new URL(endpoint, window.location.origin);
    const useServices = fileScope
      ? fileScope === "services"
      : Boolean(document.getElementById("navServices")?.classList.contains("active"));
    if (useServices) url.searchParams.set("scope", "services");
    else url.searchParams.delete("scope");
    return url.pathname + url.search;
  },

  async request(endpoint, options = {}) {
    const fileScope = options.fileScope || null;
    const requestOptions = { ...options };
    delete requestOptions.fileScope;
    endpoint = this.withFileScope(endpoint, fileScope);
    const defaultHeaders = {};
    if (options.body && !(options.body instanceof FormData)) {
      defaultHeaders["Content-Type"] = "application/json";
    }

    const config = {
      ...requestOptions,
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

  getFileContent(path, fileScope = null) {
    return this.request(`/api/files/content?path=${encodeURIComponent(path)}`, { fileScope });
  },

  getFileProperties(path) {
    const params = new URLSearchParams({ path });
    return this.request(`/api/files/properties?${params.toString()}`);
  },

  saveFileContent(path, content, fileScope = null) {
    return this.request("/api/files/content", {
      method: "POST",
      body: JSON.stringify({ path, content }),
      fileScope
    });
  },

  saveBinaryFile(path, content_b64, fileScope = null) {
    return this.request("/api/files/save-binary", {
      method: "POST",
      body: JSON.stringify({ path, content_b64 }),
      fileScope
    });
  },

  checkUploadConflicts(target_path, relative_paths, fileScope = null) {
    return this.request("/api/files/upload/check", {
      method: "POST",
      body: JSON.stringify({ target_path, relative_paths }),
      fileScope
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

  renameItem(path, new_name) {
    return this.request("/api/files/rename", {
      method: "POST",
      body: JSON.stringify({ path, new_name })
    });
  },

  copyItem(source_path, target_folder, fileScope = null) {
    return this.request("/api/files/copy", {
      method: "POST",
      body: JSON.stringify({ source_path, target_folder }),
      fileScope
    });
  },

  moveItem(source_path, target_folder, fileScope = null) {
    return this.request("/api/files/move", {
      method: "POST",
      body: JSON.stringify({ source_path, target_folder }),
      fileScope
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

  async downloadSelectedZip(items, fileScope = null) {
    const response = await fetch(this.withFileScope("/api/files/download-selected-zip", fileScope), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    });
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

  getServices() {
    return this.request("/api/services");
  },

  runServiceAction(serviceId, action) {
    return this.request("/api/services/" + encodeURIComponent(serviceId) + "/" + encodeURIComponent(action), { method: "POST" });
  },

  getServiceCredentials(serviceId) {
    return this.request("/api/services/" + encodeURIComponent(serviceId) + "/credentials");
  },

  getServiceTask(taskId) {
    return this.request("/api/services/tasks/" + encodeURIComponent(taskId));
  },

  startPortTunnel(port) {
    return this.request("/api/system/ports/" + encodeURIComponent(port) + "/tunnel", { method: "POST" });
  },

  closeLocalPort(port) {
    return this.request("/api/system/ports/" + encodeURIComponent(port), { method: "DELETE" });
  },

  stopPortTunnel(port) {
    return this.request("/api/system/ports/" + encodeURIComponent(port) + "/tunnel", { method: "DELETE" });
  }
};

