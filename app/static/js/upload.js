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

  async uploadFilesList(files) {
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
    if (totalBytes > 80 * 1024 * 1024) {
      return this.uploadFilesInChunks(files, totalBytes, progressBar, progressText);
    }
    const formData = new FormData();
    formData.append("target_path", AppState.currentPath);

    files.forEach((file) => {
      formData.append("files", file);
      // Pass relative path if uploaded via folder input
      formData.append("relative_paths", file.webkitRelativePath || "");
    });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files/upload", true);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          if (progressBar) progressBar.style.width = percent + "%";
          if (progressText) progressText.textContent = `${percent}% (${UI.formatSize(e.loaded)} / ${UI.formatSize(e.total)})`;
        }
      };

      xhr.onload = () => {
        this.isUploading = false;
        setTimeout(() => UI.closeModal("uploadModal"), 600);

        if (xhr.status >= 200 && xhr.status < 300) {
          UI.toast(t("upload_success", { count: files.length }), "success");
          App.loadDirectory(AppState.currentPath);
          App.refreshSystemStats();
          resolve();
        } else {
          let errorMsg = t("upload_error");
          try {
            const res = JSON.parse(xhr.responseText);
            errorMsg = res.detail || errorMsg;
          } catch (_) {}
          UI.toast(errorMsg, "error");
          reject(new Error(errorMsg));
        }
      };

      xhr.onerror = () => {
        this.isUploading = false;
        UI.closeModal("uploadModal");
        UI.toast(t("upload_error"), "error");
        reject(new Error(t("upload_error")));
      };

      xhr.send(formData);
    });
  },

  async uploadFilesInChunks(files, totalBytes, progressBar, progressText) {
    const chunkSize = 8 * 1024 * 1024;
    let completedBytes = 0;

    try {
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
          formData.append("chunk", blob, "chunk.bin");

          await new Promise((resolve, reject) => {
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
                resolve();
                return;
              }
              let errorMsg = "Upload failed (HTTP " + xhr.status + ").";
              try {
                const response = JSON.parse(xhr.responseText);
                errorMsg = response.detail || errorMsg;
              } catch (_) {}
              reject(new Error(errorMsg));
            };
            xhr.onerror = () => reject(new Error(t("upload_error")));
            xhr.send(formData);
          });

          completedBytes += blob.size;
          offset = end;
        }
      }

      this.isUploading = false;
      setTimeout(() => UI.closeModal("uploadModal"), 600);
      UI.toast(t("upload_success", { count: files.length }), "success");
      App.loadDirectory(AppState.currentPath);
      App.refreshSystemStats();
    } catch (error) {
      this.isUploading = false;
      UI.closeModal("uploadModal");
      const errorMsg = error && error.message ? error.message : t("upload_error");
      UI.toast(errorMsg, "error");
      throw error;
    }
  }
};

