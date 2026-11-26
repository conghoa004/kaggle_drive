/* ============================================================
   KAGGLE CLOUD DRIVE - UPLOAD MANAGER (DRAG & DROP + FOLDERS)
   ============================================================ */

const Uploader = {
  isUploading: false,
  cancelRequested: false,
  activeXhr: null,
  awaitingOverwriteConfirmation: false,
  activeChunkUploads: [],

  cancellationError() {
    const error = new Error(t("upload_cancelled"));
    error.name = "AbortError";
    return error;
  },

  throwIfCancelled() {
    if (this.cancelRequested) throw this.cancellationError();
  },

  cancelUpload() {
    if (!this.isUploading || this.cancelRequested) return;
    this.cancelRequested = true;

    const button = document.getElementById("uploadCancelButton");
    if (button) {
      button.disabled = true;
      const label = button.querySelector("[data-i18n]");
      if (label) label.textContent = t("upload_canceling");
    }

    if (this.awaitingOverwriteConfirmation) UI.resolveConfirmation(false);
    if (this.activeXhr) this.activeXhr.abort();
    const pendingUploads = this.activeChunkUploads.slice();
    if (pendingUploads.length) {
      const targetPath = pendingUploads[0].target_path;
      API.cancelUploadChunks(
        targetPath,
        pendingUploads.map(({ upload_id, relative_path }) => ({ upload_id, relative_path }))
      ).catch(() => {});
    }
  },

  showProgress() {
    const widget = document.getElementById("uploadProgressWidget");
    if (!widget) return;
    widget.classList.remove("hidden");
    widget.setAttribute("aria-hidden", "false");
    const button = document.getElementById("uploadCancelButton");
    if (button) {
      button.disabled = false;
      const label = button.querySelector("[data-i18n]");
      if (label) label.textContent = t("upload_cancel_button");
    }
    UI.updateBackgroundTaskLayout();
  },

  hideProgress() {
    const widget = document.getElementById("uploadProgressWidget");
    if (widget) {
      widget.classList.add("hidden");
      widget.setAttribute("aria-hidden", "true");
    }
    const button = document.getElementById("uploadCancelButton");
    if (button) button.disabled = false;
    UI.updateBackgroundTaskLayout();
  },

  init() {
    window.addEventListener("beforeunload", event => {
      const editorHasUnsavedChanges = Boolean(window.Editor && window.Editor.isDirty);
      if (!this.isUploading && !editorHasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    });
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
    this.cancelRequested = false;
    this.activeXhr = null;
    this.awaitingOverwriteConfirmation = false;
    this.activeChunkUploads = [];
    this.showProgress();
    const targetPath = String(AppState.currentPath || "");
    const refreshTargetView = () => {
      if (AppState.currentPath === targetPath) {
        App.loadDirectory(targetPath, false);
      }
    };

    const progressBar = document.getElementById("uploadProgressBar");
    const progressText = document.getElementById("uploadProgressText");
    const fileListText = document.getElementById("uploadFileListText");
    const overwritePaths = new Set();
    const skipPaths = new Set();
    const normalizePath = path => String(path || "")
      .split("/")
      .filter(part => part && part !== ".")
      .join("/");
    const destinationFor = relativePath => normalizePath(
      [targetPath, relativePath].filter(Boolean).join("/")
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
      this.awaitingOverwriteConfirmation = true;
      let mode;
      try {
        mode = await UI.chooseOverwriteMode(pending, knownCount);
      } finally {
        this.awaitingOverwriteConfirmation = false;
      }
      this.throwIfCancelled();
      if (mode === "all") {
        pending.forEach(path => overwritePaths.add(path));
        return true;
      }
      if (mode !== "review") return false;

      for (const path of pending) {
        this.awaitingOverwriteConfirmation = true;
        let decision;
        try {
          decision = await UI.confirmOverwriteFile(path);
        } finally {
          this.awaitingOverwriteConfirmation = false;
        }
        this.throwIfCancelled();
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
        targetPath, relativePaths
      );
      this.throwIfCancelled();
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
          // Chunk requests have server-side cancellation. A single multipart
          // request could keep saving after the browser aborts its XHR.
          await this.uploadFilesInChunks(
            uploadFiles, totalBytes, progressBar, progressText,
            overwritePaths, skipPaths, targetPath
          );
          this.throwIfCancelled();
          break;
        } catch (error) {
          const detail = error && error.data && error.data.detail;
          if (error.status !== 409 || !detail || detail.code !== "overwrite_required") {
            throw error;
          }
          if (++retries > 10) throw error;

          const latest = await API.checkUploadConflicts(
            targetPath,
            uploadFiles.map(relativePathFor)
          );
          this.throwIfCancelled();
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
            if (uploadAttempted) refreshTargetView();
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
      refreshTargetView();
      App.refreshSystemStats();
    } catch (error) {
      if (this.cancelRequested || (error && error.name === "AbortError")) {
        if (uploadAttempted) refreshTargetView();
        UI.toast(t("upload_cancelled"), "info");
        return;
      }
      const errorMsg = error && error.message ? error.message : t("upload_error");
      UI.toast(errorMsg, "error");
      if (uploadAttempted) refreshTargetView();
      throw error;
    } finally {
      this.isUploading = false;
      this.activeXhr = null;
      this.awaitingOverwriteConfirmation = false;
      this.activeChunkUploads = [];
      this.hideProgress();
    }
  },

  uploadFilesMultipart(
    files, overwritePaths = new Set(), skipPaths = new Set(), targetPath = ""
  ) {
    const formData = new FormData();
    formData.append("target_path", targetPath);
    formData.append("overwrite", "false");
    overwritePaths.forEach(path => formData.append("overwrite_paths", path));
    skipPaths.forEach(path => formData.append("skip_paths", path));
    files.forEach(file => {
      formData.append("files", file);
      formData.append("relative_paths", file.webkitRelativePath || "");
    });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.activeXhr = xhr;
      const clearActiveXhr = () => {
        if (this.activeXhr === xhr) this.activeXhr = null;
      };
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
        clearActiveXhr();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(this.xhrError(xhr, t("upload_error")));
        }
      };
      xhr.onerror = () => {
        clearActiveXhr();
        reject(new Error(t("upload_error")));
      };
      xhr.onabort = () => {
        clearActiveXhr();
        reject(this.cancellationError());
      };
      xhr.send(formData);
    });
  },

  async uploadFilesInChunks(
    files, totalBytes, progressBar, progressText,
    overwritePaths = new Set(), skipPaths = new Set(), targetPath = ""
  ) {
    const chunkSize = 8 * 1024 * 1024;
    let completedBytes = 0;

    for (const file of files) {
      this.throwIfCancelled();
      const uploadId = (window.crypto && typeof window.crypto.randomUUID === "function")
        ? window.crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
            const random = Math.random() * 16 | 0;
            return (char === "x" ? random : (random & 3 | 8)).toString(16);
          });
      const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
      let offset = 0;
      const uploadRecord = {
        upload_id: uploadId,
        relative_path: file.webkitRelativePath || file.name,
        target_path: targetPath
      };
      this.activeChunkUploads.push(uploadRecord);

      try {
        for (let index = 0; index < chunkCount; index++) {
          this.throwIfCancelled();
          const end = Math.min(offset + chunkSize, file.size);
          const blob = file.slice(offset, end);
          const formData = new FormData();
          formData.append("target_path", targetPath);
          formData.append("relative_path", uploadRecord.relative_path);
          formData.append("upload_id", uploadId);
          formData.append("offset", String(offset));
          formData.append("total_size", String(file.size));
          formData.append("batch_size", String(totalBytes));
          const destination = [targetPath, uploadRecord.relative_path]
            .filter(Boolean)
            .join("/")
            .split("/")
            .filter(part => part && part !== ".")
            .join("/");
          formData.append("overwrite", String(overwritePaths.has(destination)));
          overwritePaths.forEach(path => formData.append("overwrite_paths", path));
          skipPaths.forEach(path => formData.append("skip_paths", path));
          formData.append("chunk", blob, "chunk.bin");

          const chunkResult = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            this.activeXhr = xhr;
            const clearActiveXhr = () => {
              if (this.activeXhr === xhr) this.activeXhr = null;
            };
            xhr.open("POST", "/api/files/upload/chunk", true);
            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable && progressBar && progressText) {
                const inFlight = Math.min(blob.size, event.loaded);
                const percent = totalBytes > 0
                  ? Math.round(((completedBytes + inFlight) / totalBytes) * 100)
                  : 0;
                progressBar.style.width = percent + "%";
                progressText.textContent = percent + "% (" +
                  UI.formatSize(completedBytes + inFlight) + " / " + UI.formatSize(totalBytes) + ")";
              }
            };
            xhr.onload = () => {
              clearActiveXhr();
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
            xhr.onerror = () => {
              clearActiveXhr();
              reject(new Error(t("upload_error")));
            };
            xhr.onabort = () => {
              clearActiveXhr();
              reject(this.cancellationError());
            };
            xhr.send(formData);
          });

          if (chunkResult.status === "skipped") {
            completedBytes += file.size - offset;
            break;
          }
          completedBytes += blob.size;
          offset = end;
        }
      } catch (error) {
        await API.cancelUploadChunks(targetPath, [{
          upload_id: uploadId,
          relative_path: uploadRecord.relative_path
        }]).catch(() => {});
        throw error;
      } finally {
        this.activeChunkUploads = this.activeChunkUploads.filter(
          upload => upload.upload_id !== uploadId
        );
      }
    }

    if (totalBytes === 0) {
      if (progressBar) progressBar.style.width = "100%";
      if (progressText) {
        progressText.textContent = "100% (" +
          UI.formatSize(0) + " / " + UI.formatSize(0) + ")";
      }
    }
  }
};

