/* ============================================================
   KAGGLE CLOUD DRIVE - UPLOAD MANAGER (DRAG & DROP + FOLDERS)
   ============================================================ */

const Uploader = {
  isUploading: false,

  showProgress() {
    const widget = document.getElementById("uploadProgressWidget");
    if (!widget) return;
    widget.classList.remove("hidden");
    widget.setAttribute("aria-hidden", "false");
    document.body.classList.add("upload-in-progress");
  },

  hideProgress() {
    const widget = document.getElementById("uploadProgressWidget");
    if (widget) {
      widget.classList.add("hidden");
      widget.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("upload-in-progress");
  },

  init() {
    this.setupGlobalDragDrop();
    this.setupFileInputs();
  },

  setupGlobalDragDrop() {
    const overlay = document.getElementById("dragOverlay");
    let dragCounter = 0;
    const isFileDrag = (event) => {
      const transfer = event.dataTransfer;
      if (!transfer) return false;

      const types = Array.from(transfer.types || []);
      if (types.includes("Files")) return true;

      return Array.from(transfer.items || []).some(item => item.kind === "file");
    };
    const isStorageView = () => {
      const storageNav = document.getElementById("navStorage");
      const mainContent = document.getElementById("mainContentArea");
      return Boolean(
        storageNav && storageNav.classList.contains("active") &&
        mainContent && !mainContent.classList.contains("hidden")
      );
    };

    window.addEventListener("dragenter", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (!isStorageView()) return;
      dragCounter++;
      if (overlay) overlay.classList.add("active");
    });

    window.addEventListener("dragleave", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (!isStorageView()) return;
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        if (overlay) overlay.classList.remove("active");
      }
    });

    window.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    });

    window.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;

      e.preventDefault();
      dragCounter = 0;
      if (overlay) overlay.classList.remove("active");

      if (isStorageView()) {
        this.uploadFilesList(Array.from(files));
      }
    });
  },

  setupFileInputs() {
    const fileInput = document.getElementById("fileInput");
    const folderInput = document.getElementById("folderInput");

    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.uploadFilesList(Array.from(e.target.files));
          e.target.value = "";
        }
      });
    }

    if (folderInput) {
      folderInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.uploadFilesList(Array.from(e.target.files));
          e.target.value = "";
        }
      });
    }
  },

  xhrError(xhr, fallback) {
    let data = {};
    try {
      data = JSON.parse(xhr.responseText);
    } catch (_) {}
    const detail = data.detail;
    const message = (typeof detail === "string" ? detail : detail && detail.message) || fallback;
    const error = new Error(message);
    error.status = xhr.status;
    error.data = data;
    return error;
  },

  async uploadFilesList(files) {
    if (!files.length) return;
    if (this.isUploading) {
      UI.toast(t("upload_busy"), "warning");
      return;
    }

    this.isUploading = true;
    this.showProgress();

    const progressBar = document.getElementById("uploadProgressBar");
    const progressText = document.getElementById("uploadProgressText");
    const fileListText = document.getElementById("uploadFileListText");
    const overwritePaths = new Set();
    const skipPaths = new Set();
    const normalizePath = path => String(path || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(part => part && part !== ".")
      .join("/");
    const destinationFor = relativePath => normalizePath(
      [AppState.currentPath, relativePath].filter(Boolean).join("/")
    );
    const relativePathFor = file => file.webkitRelativePath || file.name;
    let uploadAttempted = false;

    const chooseConflicts = async (paths, count = paths.length) => {
      const normalized = [...new Set(paths.map(normalizePath).filter(Boolean))];
      const pending = normalized.filter(path =>
        !overwritePaths.has(path) && !skipPaths.has(path)
      );
      if (!pending.length) return true;

      const knownCount = Math.max(
        pending.length,
        count - (normalized.length - pending.length)
      );
      const mode = await UI.chooseOverwriteMode(pending, knownCount);
      if (mode === "all") {
        pending.forEach(path => overwritePaths.add(path));
        return true;
      }
      if (mode !== "review") return false;

      for (const path of pending) {
        const decision = await UI.confirmOverwriteFile(path);
        if (decision === false) return false;
        if (decision === "overwrite") overwritePaths.add(path);
        else skipPaths.add(path);
      }
      return true;
    };

    try {
      if (progressBar) progressBar.style.width = "0%";
      if (progressText) progressText.textContent = "0%";
      if (fileListText) fileListText.textContent = t("upload_preparing", { count: files.length });

      const relativePaths = files.map(relativePathFor);
      const initialCheck = await API.checkUploadConflicts(
        AppState.currentPath, relativePaths
      );
      if (initialCheck.conflicts && initialCheck.conflicts.length) {
        const confirmed = await chooseConflicts(
          initialCheck.conflicts, initialCheck.conflicts.length
        );
        if (!confirmed) {
          return;
        }
      }

      let retries = 0;
      while (true) {
        const uploadFiles = files.filter(file =>
          !skipPaths.has(destinationFor(relativePathFor(file)))
        );
        if (!uploadFiles.length) {
          UI.toast(t("upload_success_skipped", {
            uploaded: 0,
            skipped: skipPaths.size
          }), "success");
          return;
        }

        const totalBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
        if (progressBar) progressBar.style.width = "0%";
        if (progressText) progressText.textContent = "0%";
        if (fileListText) {
          fileListText.textContent = t("upload_preparing", { count: uploadFiles.length });
        }

        try {
          uploadAttempted = true;
          if (totalBytes > 80 * 1024 * 1024) {
            await this.uploadFilesInChunks(
              uploadFiles, totalBytes, progressBar, progressText, overwritePaths, skipPaths
            );
          } else {
            await this.uploadFilesMultipart(uploadFiles, overwritePaths, skipPaths);
          }
          break;
        } catch (error) {
          const detail = error && error.data && error.data.detail;
          if (error.status !== 409 || !detail || detail.code !== "overwrite_required") {
            throw error;
          }
          if (++retries > 10) throw error;

          const latest = await API.checkUploadConflicts(
            AppState.currentPath,
            uploadFiles.map(relativePathFor)
          );
          const conflicts = [...new Set([
            ...(detail.paths || []),
            ...(latest.conflicts || [])
          ])];
          const conflictCount = Math.max(
            detail.count || 0,
            latest.conflicts ? latest.conflicts.length : 0,
            conflicts.length
          );
          if (!await chooseConflicts(conflicts, conflictCount)) {
            if (uploadAttempted) App.loadDirectory(AppState.currentPath);
            return;
          }
        }
      }

      if (skipPaths.size) {
        UI.toast(t("upload_success_skipped", {
          uploaded: files.length - skipPaths.size,
          skipped: skipPaths.size
        }), "success");
      } else {
        UI.toast(t("upload_success", { count: files.length }), "success");
      }
      App.loadDirectory(AppState.currentPath);
      App.refreshSystemStats();
    } catch (error) {
      const errorMsg = error && error.message ? error.message : t("upload_error");
      UI.toast(errorMsg, "error");
      if (uploadAttempted) App.loadDirectory(AppState.currentPath);
      throw error;
    } finally {
      this.isUploading = false;
      this.hideProgress();
    }
  },

  uploadFilesMultipart(files, overwritePaths = new Set(), skipPaths = new Set()) {
    const formData = new FormData();
    formData.append("target_path", AppState.currentPath);
    formData.append("overwrite", "false");
    overwritePaths.forEach(path => formData.append("overwrite_paths", path));
    skipPaths.forEach(path => formData.append("skip_paths", path));
    files.forEach(file => {
      formData.append("files", file);
      formData.append("relative_paths", file.webkitRelativePath || "");
    });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files/upload", true);
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          const progressBar = document.getElementById("uploadProgressBar");
          const progressText = document.getElementById("uploadProgressText");
          if (progressBar) progressBar.style.width = percent + "%";
          if (progressText) {
            progressText.textContent = `${percent}% (${UI.formatSize(event.loaded)} / ${UI.formatSize(event.total)})`;
          }
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(this.xhrError(xhr, t("upload_error")));
        }
      };
      xhr.onerror = () => reject(new Error(t("upload_error")));
      xhr.send(formData);
    });
  },

  async uploadFilesInChunks(
    files, totalBytes, progressBar, progressText,
    overwritePaths = new Set(), skipPaths = new Set()
  ) {
    const chunkSize = 8 * 1024 * 1024;
    let completedBytes = 0;

    for (const file of files) {
      const uploadId = (window.crypto && typeof window.crypto.randomUUID === "function")
        ? window.crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
            const random = Math.random() * 16 | 0;
            return (char === "x" ? random : (random & 3 | 8)).toString(16);
          });
      const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
      let offset = 0;

      for (let index = 0; index < chunkCount; index++) {
        const end = Math.min(offset + chunkSize, file.size);
        const blob = file.slice(offset, end);
        const formData = new FormData();
        formData.append("target_path", AppState.currentPath);
        formData.append("relative_path", file.webkitRelativePath || file.name);
        formData.append("upload_id", uploadId);
        formData.append("offset", String(offset));
        formData.append("total_size", String(file.size));
        formData.append("batch_size", String(totalBytes));
        const destination = [AppState.currentPath, file.webkitRelativePath || file.name]
          .filter(Boolean)
          .join("/")
          .replace(/\\/g, "/")
          .split("/")
          .filter(part => part && part !== ".")
          .join("/");
        formData.append("overwrite", String(overwritePaths.has(destination)));
        overwritePaths.forEach(path => formData.append("overwrite_paths", path));
        skipPaths.forEach(path => formData.append("skip_paths", path));
        formData.append("chunk", blob, "chunk.bin");

        const chunkResult = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/files/upload/chunk", true);
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && progressBar && progressText) {
              const inFlight = Math.min(blob.size, event.loaded);
              const percent = Math.round(((completedBytes + inFlight) / totalBytes) * 100);
              progressBar.style.width = percent + "%";
              progressText.textContent = percent + "% (" +
                UI.formatSize(completedBytes + inFlight) + " / " + UI.formatSize(totalBytes) + ")";
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText || "{}"));
              } catch (_) {
                resolve({});
              }
              return;
            }
            reject(this.xhrError(xhr, "Upload failed (HTTP " + xhr.status + ")."));
          };
          xhr.onerror = () => reject(new Error(t("upload_error")));
          xhr.send(formData);
        });

        if (chunkResult.status === "skipped") {
          completedBytes += file.size - offset;
          break;
        }
        completedBytes += blob.size;
        offset = end;
      }
    }
  }
};

