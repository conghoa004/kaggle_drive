/* ============================================================
   KAGGLE CLOUD DRIVE - UPLOAD MANAGER (DRAG & DROP + FOLDERS)
   ============================================================ */

const Uploader = {
  isUploading: false,

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

  async uploadFilesList(files, overwrite = false) {
    if (!files.length) return;
    if (this.isUploading) {
      UI.toast(t("upload_busy"), "warning");
      return;
    }

    this.isUploading = true;
    UI.openModal("uploadModal");

    const progressBar = document.getElementById("uploadProgressBar");
    const progressText = document.getElementById("uploadProgressText");
    const fileListText = document.getElementById("uploadFileListText");
    if (progressBar) progressBar.style.width = "0%";
    if (progressText) progressText.textContent = "0%";
    if (fileListText) fileListText.textContent = t("upload_preparing", { count: files.length });

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    try {
      if (!overwrite) {
        const relativePaths = files.map(file => file.webkitRelativePath || file.name);
        const result = await API.checkUploadConflicts(
          AppState.currentPath,
          relativePaths,
          AppState.isServicesMode ? "services" : "storage"
        );
        if (result.conflicts && result.conflicts.length) {
          const confirmed = await UI.confirmOverwrite(result.conflicts, result.conflicts.length);
          if (!confirmed) {
            UI.closeModal("uploadModal");
            return;
          }
          overwrite = true;
        }
      }

      if (totalBytes > 80 * 1024 * 1024) {
        await this.uploadFilesInChunks(files, totalBytes, progressBar, progressText, overwrite);
      } else {
        await this.uploadFilesMultipart(files, overwrite);
      }

      setTimeout(() => UI.closeModal("uploadModal"), 600);
      UI.toast(t("upload_success", { count: files.length }), "success");
      App.loadDirectory(AppState.currentPath);
      App.refreshSystemStats();
    } catch (error) {
      const detail = error && error.data && error.data.detail;
      if (!overwrite && error.status === 409 && detail && detail.code === "overwrite_required") {
        const conflictPaths = new Set(detail.paths || []);
        let conflictCount = detail.count || conflictPaths.size;
        try {
          const latest = await API.checkUploadConflicts(
            AppState.currentPath,
            files.map(file => file.webkitRelativePath || file.name),
            AppState.isServicesMode ? "services" : "storage"
          );
          (latest.conflicts || []).forEach(path => conflictPaths.add(path));
          conflictCount = Math.max(conflictCount, conflictPaths.size);
        } catch (checkError) {
          UI.closeModal("uploadModal");
          UI.toast(checkError.message || t("upload_error"), "error");
          throw checkError;
        }
        const confirmed = await UI.confirmOverwrite([...conflictPaths], conflictCount);
        if (confirmed) {
          UI.closeModal("uploadModal");
          this.isUploading = false;
          return await this.uploadFilesList(files, true);
        }
        UI.closeModal("uploadModal");
        return;
      }
      UI.closeModal("uploadModal");
      const errorMsg = error && error.message ? error.message : t("upload_error");
      UI.toast(errorMsg, "error");
      throw error;
    } finally {
      this.isUploading = false;
    }
  },

  uploadFilesMultipart(files, overwrite) {
    const formData = new FormData();
    formData.append("target_path", AppState.currentPath);
    formData.append("overwrite", String(overwrite));
    files.forEach(file => {
      formData.append("files", file);
      formData.append("relative_paths", file.webkitRelativePath || "");
    });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API.withFileScope("/api/files/upload"), true);
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

  async uploadFilesInChunks(files, totalBytes, progressBar, progressText, overwrite = false) {
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
        formData.append("overwrite", String(overwrite));
        formData.append("chunk", blob, "chunk.bin");

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", API.withFileScope("/api/files/upload/chunk"), true);
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
              resolve();
              return;
            }
            reject(this.xhrError(xhr, "Upload failed (HTTP " + xhr.status + ")."));
          };
          xhr.onerror = () => reject(new Error(t("upload_error")));
          xhr.send(formData);
        });

        completedBytes += blob.size;
        offset = end;
      }
    }
  }
};

