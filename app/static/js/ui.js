/* ============================================================
   KAGGLE CLOUD DRIVE - UI UTILITIES & OFFICIAL ICONS
   Using Font Awesome 6 Pro-grade Official Vector Icons
   ============================================================ */

const UI = {
  confirmationResolver: null,

  // Toast Notification System
  toast(message, type = "info", duration = 3200) {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const icons = {
      success: '<i class="fa-solid fa-circle-check"></i>',
      error: '<i class="fa-solid fa-circle-xmark"></i>',
      warning: '<i class="fa-solid fa-triangle-exclamation"></i>',
      info: '<i class="fa-solid fa-circle-info"></i>'
    };

    const toastEl = document.createElement("div");
    toastEl.className = `toast ${type}`;
    toastEl.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${this.escape(message)}</span>`;

    container.appendChild(toastEl);

    setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateX(25px)";
      toastEl.style.transition = "all 0.25s ease";
      setTimeout(() => toastEl.remove(), 260);
    }, duration);
  },

  // Modal Control
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add("show");
      const firstInput = modal.querySelector("input:not([type=hidden]), textarea");
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 80);
      }
    }
  },

  confirm(options = {}) {
    const modal = document.getElementById("confirmationModal");
    if (!modal || this.confirmationResolver) return Promise.resolve(false);

    const title = document.getElementById("confirmationTitle");
    const message = document.getElementById("confirmationMessage");
    const cancelButton = document.getElementById("confirmationCancelButton");
    const confirmButton = document.getElementById("confirmationConfirmButton");
    const confirmLabel = confirmButton && confirmButton.querySelector("span");
    const actionIcon = document.getElementById("confirmationActionIcon");
    const extraButton = document.getElementById("confirmationExtraButton");
    if (title) title.textContent = options.title || t("confirm_title");
    if (message) message.textContent = options.message || "";
    if (cancelButton) cancelButton.textContent = options.cancelText || t("cancel");
    if (confirmLabel) confirmLabel.textContent = options.confirmText || t("confirm");
    if (actionIcon) actionIcon.className = "fa-solid " + (options.confirmIcon || "fa-check");
    if (cancelButton) {
      cancelButton.onclick = () => this.resolveConfirmation(
        Object.prototype.hasOwnProperty.call(options, "cancelValue") ? options.cancelValue : false
      );
    }
    if (confirmButton) {
      confirmButton.onclick = () => this.resolveConfirmation(
        Object.prototype.hasOwnProperty.call(options, "confirmValue") ? options.confirmValue : true
      );
    }
    if (extraButton) {
      const showExtra = Boolean(options.extraText);
      extraButton.style.display = showExtra ? "" : "none";
      extraButton.textContent = options.extraText || "";
      extraButton.onclick = () => this.resolveConfirmation(options.extraValue);
    }

    return new Promise(resolve => {
      this.confirmationResolver = resolve;
      this.openModal("confirmationModal");
      if (cancelButton) setTimeout(() => cancelButton.focus(), 80);
    });
  },

  overwriteMessage(paths = [], count = paths.length) {
    const shownPaths = paths.slice(0, 5);
    const moreCount = Math.max(0, count - shownPaths.length);
    const more = moreCount ? t("overwrite_more", { count: moreCount }) : "";
    return t("overwrite_confirm", { paths: shownPaths.join(", "), more });
  },

  confirmOverwrite(paths = [], count = paths.length) {
    return this.confirm({
      title: t("overwrite_title"),
      message: this.overwriteMessage(paths, count),
      confirmText: t("overwrite_action"),
      confirmIcon: "fa-file-circle-check"
    });
  },

  chooseOverwriteMode(paths = [], count = paths.length) {
    const reviewAvailable = count <= paths.length;
    const message = this.overwriteMessage(paths, count) + (
      reviewAvailable ? "" : "\n\n" + t("overwrite_review_unavailable")
    );
    return this.confirm({
      title: t("overwrite_title"),
      message,
      cancelText: t("cancel"),
      cancelValue: "cancel",
      confirmText: t("overwrite_all"),
      confirmValue: "all",
      confirmIcon: "fa-file-circle-check",
      extraText: reviewAvailable ? t("overwrite_review_each") : "",
      extraValue: "review"
    });
  },

  confirmOverwriteFile(path) {
    return this.confirm({
      title: t("overwrite_title"),
      message: t("overwrite_file_confirm", { path }),
      cancelText: t("overwrite_skip"),
      cancelValue: "skip",
      confirmText: t("overwrite_action"),
      confirmValue: "overwrite",
      confirmIcon: "fa-file-circle-check"
    });
  },

  resolveConfirmation(confirmed) {
    const resolve = this.confirmationResolver;
    this.confirmationResolver = null;
    const modal = document.getElementById("confirmationModal");
    if (modal) modal.classList.remove("show");
    if (resolve) resolve(confirmed);
  },

  closeModal(modalId) {
    if (modalId === "confirmationModal") {
      this.resolveConfirmation(false);
      return;
    }
    if (modalId === "previewModal" && window.Previewer && typeof window.Previewer.closePreview === "function") {
      window.Previewer.closePreview();
      return;
    }
    if (modalId === "editorModal" && window.Editor && typeof window.Editor.close === "function") {
      window.Editor.close();
      return;
    }
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove("show");
    }
  },

  closeAllModals() {
    const confirmationModal = document.getElementById("confirmationModal");
    if (confirmationModal && confirmationModal.classList.contains("show")) {
      this.resolveConfirmation(false);
      return;
    }
    const unsavedModal = document.getElementById("unsavedChangesModal");
    if (unsavedModal && unsavedModal.classList.contains("show")) {
      this.closeModal("unsavedChangesModal");
      return;
    }
    if (window.Previewer && window.Previewer.spreadsheetState && window.Previewer.spreadsheetState.isDirty) {
      window.Previewer.closePreview();
      return;
    }
    if (window.Editor && window.Editor.isDirty) {
      window.Editor.close();
      return;
    }
    if (window.Previewer && typeof window.Previewer.closePreview === "function") {
      window.Previewer.closePreview();
    }
    document.querySelectorAll(".modal-overlay").forEach(m => {
      m.classList.remove("show");
      m.querySelectorAll("video, audio").forEach(el => {
        try {
          el.pause();
          el.src = "";
          el.load();
        } catch (_) {}
      });
    });
  },

  // Official Font Awesome 6 Vector Icon Mapping
  getIcon(item) {
    if (item.is_dir) {
      return '<i class="fa-solid fa-folder icon-folder"></i>';
    }

    const ext = (item.extension || "").toLowerCase();

    // Specific file extensions
    if (ext === "py") {
      return '<i class="fa-brands fa-python icon-python"></i>';
    }
    if (ext === "ipynb") {
      return '<i class="fa-solid fa-book-bookmark icon-notebook"></i>';
    }
    if (ext === "md") {
      return '<i class="fa-brands fa-markdown icon-markdown"></i>';
    }
    if (ext === "pdf") {
      return '<i class="fa-solid fa-file-pdf icon-pdf"></i>';
    }
    if (ext === "xlsx" || ext === "xls") {
      return '<i class="fa-solid fa-file-excel icon-excel"></i>';
    }
    if (ext === "csv" || ext === "tsv") {
      return '<i class="fa-solid fa-file-csv icon-csv"></i>';
    }
    if (["safetensors", "pth", "pt", "bin", "onnx", "h5", "ckpt"].includes(ext)) {
      return '<i class="fa-solid fa-brain icon-ai-model"></i>';
    }
    if (["zip", "tar", "gz", "tgz", "bz2", "7z", "rar"].includes(ext)) {
      return '<i class="fa-solid fa-file-zipper icon-archive"></i>';
    }

    // Category fallbacks
    const category = item.category;
    if (category === "image") {
      return '<i class="fa-solid fa-file-image icon-image"></i>';
    }
    if (category === "video") {
      return '<i class="fa-solid fa-file-video icon-video"></i>';
    }
    if (category === "audio") {
      return '<i class="fa-solid fa-file-audio icon-audio"></i>';
    }
    if (category === "code") {
      return '<i class="fa-solid fa-file-code icon-code"></i>';
    }

    return '<i class="fa-solid fa-file-lines icon-text"></i>';
  },

  // HTML escaping
  escape(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  },

  inlineJsString(value) {
    return String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/'/g, "&#39;");
  },

  formatSize(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
  }
};
