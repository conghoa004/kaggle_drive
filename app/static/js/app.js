/* ============================================================
   KAGGLE CLOUD DRIVE - MAIN APPLICATION CONTROLLER
   ============================================================ */

const AppState = {
  currentPath: localStorage.getItem("kaggle_drive_current_path") || "",
  storagePath: localStorage.getItem("kaggle_drive_storage_path") || "",
  parentPath: null,
  rootDir: "",
  files: [],
  selectedItems: new Set(),
  fileClipboard: null,
  lastSelectedPath: null,
  terminalCwd: "",
  viewMode: localStorage.getItem("kaggle_drive_view_mode") || "grid", // 'grid' | 'list'
  showHidden: false,
  searchQuery: "",
  systemStats: null,
  ports: [],
  portsError: ""
};

const App = {
  clipboardPasteInProgress: false,
  directoryLoadSequence: 0,

  init() {
    I18n.init();
    this.bindEvents();
    this.initDragSelect();
    Uploader.init();
    Editor.init();
    this.checkAuthStatus();
  },

  onLanguageChange() {
    this.renderBreadcrumb();
    this.renderFiles();
    this.updateSelectionBar();
    this.updateFileClipboardBar();
    this.renderTerminalTabs();
    const statsModal = document.getElementById("systemStatsModal");
    if (statsModal && statsModal.classList.contains("show") && AppState.systemStats) {
      this.renderSystemStatsModal(AppState.systemStats);
    }
    const portsPage = document.getElementById("portManagerPage");
    if (portsPage && !portsPage.classList.contains("hidden")) {
      this.renderPortsPage();
    }
  },

  bindEvents() {
    // Auth unauthorized listener
    window.addEventListener("auth:unauthorized", () => {
      this.closeTerminalSession({ terminate: false, preserveStored: true });
      AppState.fileClipboard = null;
      this.updateFileClipboardBar();
      this.showLoginView();
    });

    // Global Key shortcuts
    window.addEventListener("keydown", (e) => {
      const activeElement = document.activeElement;
      const isEditable = activeElement instanceof HTMLElement && (
        activeElement.matches("input, textarea, select") || activeElement.isContentEditable
      );
      const hasOpenModal = Boolean(document.querySelector(".modal-overlay.show"));
      const mainContent = document.getElementById("mainContentArea");
      const isFileManagerVisible = Boolean(mainContent && !mainContent.classList.contains("hidden"));

      if (e.key === "Escape") {
        this.hideContextMenu();
        const unsavedModal = document.getElementById("unsavedChangesModal");
        if (unsavedModal && unsavedModal.classList.contains("show")) {
          e.stopImmediatePropagation();
          UI.closeModal("unsavedChangesModal");
          return;
        }
        const terminalModal = document.getElementById("terminalModal");
        if (terminalModal && terminalModal.classList.contains("show")) {
          this.minimizeTerminal();
        }
        UI.closeAllModals();
      } else if ((e.key === "Delete" || (e.ctrlKey && e.key === "Backspace")) && !isEditable) {
        if (isFileManagerVisible && AppState.selectedItems.size > 0 && !hasOpenModal) {
          e.preventDefault();
          this.promptDelete();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !isEditable && !hasOpenModal) {
        const key = e.key.toLowerCase();
        if (isFileManagerVisible && key === "c" && AppState.selectedItems.size > 0) {
          e.preventDefault();
          this.copySelectedItems();
        } else if (isFileManagerVisible && key === "x" && AppState.selectedItems.size > 0) {
          e.preventDefault();
          this.cutSelectedItems();
        } else if (isFileManagerVisible && key === "v" && AppState.fileClipboard) {
          e.preventDefault();
          this.pasteClipboard();
        } else if (isFileManagerVisible && key === "a") {
          e.preventDefault();
          this.toggleSelectAll(true);
        }
      } else if (e.key === "/" && !isEditable) {
        e.preventDefault();
        const searchInput = document.getElementById("searchInput");
        if (searchInput) searchInput.focus();
      }
    });

    // Dismiss floating context menu on click outside, resize, scroll
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest("#contextMenu")) {
        this.hideContextMenu();
      }
    });

    window.addEventListener("resize", () => {
      this.hideContextMenu();
    });

    window.addEventListener("scroll", () => {
      this.hideContextMenu();
    }, true);

    // Search input
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        AppState.searchQuery = e.target.value.toLowerCase().trim();
        this.renderFiles();
      });
    }

    // New dropdown toggle
    const btnNew = document.getElementById("btnNewDropdown");
    const dropdownMenu = document.getElementById("dropdownNewMenu");
    if (btnNew && dropdownMenu) {
      btnNew.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdownMenu.classList.toggle("show");
      });

      document.addEventListener("click", () => {
        dropdownMenu.classList.remove("show");
      });
    }
  },

  toggleMobileSidebar(force) {
    const sidebar = document.getElementById("sidebar");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (!sidebar) return;
    const isClosed = sidebar.classList.contains("-translate-x-full");
    const shouldOpen = force !== undefined ? force : isClosed;

    if (shouldOpen) {
      sidebar.classList.remove("-translate-x-full");
      sidebar.classList.add("translate-x-0");
      if (backdrop) backdrop.classList.remove("hidden");
    } else {
      sidebar.classList.remove("translate-x-0");
      sidebar.classList.add("-translate-x-full");
      if (backdrop) backdrop.classList.add("hidden");
    }
  },

  setActiveNavigation(navId) {
    document.querySelectorAll("#sidebar .nav-link").forEach(link => {
      link.classList.toggle("active", link.id === navId);
    });
    try {
      localStorage.setItem("kaggle_drive_active_navigation", navId);
    } catch (_) {}
  },

  openStorageFolder() {
    this.loadDirectory(AppState.storagePath || "", true);
  },

  refreshCurrentDirectory() {
    return this.loadDirectory(AppState.currentPath, false);
  },

  async checkAuthStatus() {
    const authMeta = document.querySelector('meta[name="server-auth"]');
    const userMeta = document.querySelector('meta[name="server-user"]');
    const serverAuth = authMeta ? authMeta.getAttribute("content") : null;
    const serverUser = userMeta ? userMeta.getAttribute("content") : "admin";

    // Fast-path: Server already hydrated authentication state directly into HTML
    if (serverAuth === "1") {
      this.showAppView({ authenticated: true, username: serverUser || "admin" });
      // Validate session in background without UI flicker
      API.getMe().catch(() => this.showLoginView());
      return;
    }

    if (serverAuth === "0") {
      this.showLoginView();
      return;
    }

    // Fallback if metadata not present
    try {
      const data = await API.getMe();
      if (data && data.authenticated) {
        this.showAppView(data);
      } else {
        this.showLoginView();
      }
    } catch (_) {
      this.showLoginView();
    }
  },

  showLoginView() {
    const loginView = document.getElementById("loginView");
    const appContainer = document.getElementById("appContainer");
    if (loginView) {
      loginView.classList.remove("hidden");
      loginView.style.display = "flex";
    }
    if (appContainer) {
      appContainer.classList.add("hidden");
      appContainer.style.display = "none";
    }
    const usernameInput = document.getElementById("loginUsername");
    if (usernameInput) {
      usernameInput.value = "admin";
    }
    const passwordInput = document.getElementById("loginPassword");
    if (passwordInput) {
      passwordInput.value = "";
      setTimeout(() => passwordInput.focus(), 100);
    }
  },

  showAppView(userData = null) {
    const loginView = document.getElementById("loginView");
    const appContainer = document.getElementById("appContainer");
    if (loginView) {
      loginView.classList.add("hidden");
      loginView.style.display = "none";
    }
    if (appContainer) {
      appContainer.classList.remove("hidden");
      appContainer.style.display = "flex";
    }

    if (userData && userData.username) {
      const userEl = document.getElementById("currentUsername");
      if (userEl) userEl.textContent = userData.username;
    }

    this.restoreTerminalSessions();

    const savedNavigation = localStorage.getItem("kaggle_drive_active_navigation");
    if (savedNavigation === "navPorts") {
      this.openPortsPage();
    } else {
      this.loadDirectory(AppState.currentPath);
    }
    this.refreshSystemStats();
  },

  async handleLogin() {
    const usernameInput = document.getElementById("loginUsername");
    const passwordInput = document.getElementById("loginPassword");
    const errorEl = document.getElementById("loginError");

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    errorEl.textContent = "";

    if (!username || !password) {
      errorEl.textContent = t("login_empty_error");
      return;
    }

    const btn = document.getElementById("btnLogin");
    btn.disabled = true;
    btn.textContent = t("authenticating");

    try {
      await API.login(username, password);
      this.showAppView({ username });
    } catch (err) {
      errorEl.textContent = err.message || t("login_fail_error");
    } finally {
      btn.disabled = false;
      btn.textContent = t("login_btn");
    }
  },

  async handleLogout() {
    this.directoryLoadSequence += 1;
    await this.closeTerminalSession();
    try {
      await API.logout();
    } catch (_) {}
    AppState.currentPath = "";
    try {
      localStorage.removeItem("kaggle_drive_current_path");
    } catch (_) {}
    AppState.selectedItems.clear();
    AppState.fileClipboard = null;
    this.updateFileClipboardBar();
    this.showLoginView();
  },

  async loadDirectory(path = "", resetSearch = true) {
    const loadSequence = ++this.directoryLoadSequence;
    this.hideContextMenu();
    this.toggleMobileSidebar(false);
    const mainContent = document.getElementById("mainContentArea");
    const portsPage = document.getElementById("portManagerPage");
    if (mainContent) mainContent.classList.remove("hidden");
    if (portsPage) {
      portsPage.classList.add("hidden");
      portsPage.style.display = "none";
    }
    const requestedPath = String(path || "");
    const normalizedPath = requestedPath.split("/").filter(Boolean).join("/");
    this.setActiveNavigation("navStorage");
    AppState.currentPath = normalizedPath;
    AppState.storagePath = normalizedPath;
    try {
      localStorage.setItem("kaggle_drive_storage_path", normalizedPath);
      localStorage.setItem("kaggle_drive_current_path", normalizedPath);
    } catch (_) {}
    AppState.selectedItems.clear();
    AppState.lastSelectedPath = null;
    this.updateSelectionBar();

    if (resetSearch) {
      AppState.searchQuery = "";
      const searchInput = document.getElementById("searchInput");
      if (searchInput) searchInput.value = "";
    }

    try {
      const data = await API.listFiles(path, AppState.showHidden);
      if (loadSequence !== this.directoryLoadSequence) return;
      AppState.parentPath = data.parent_path;
      AppState.rootDir = data.root_dir || AppState.rootDir;
      const canonicalPath = typeof data.current_path === "string"
        ? data.current_path
        : normalizedPath;
      if (AppState.currentPath === normalizedPath) {
        AppState.currentPath = canonicalPath;
        AppState.storagePath = canonicalPath;
        try {
          localStorage.setItem("kaggle_drive_storage_path", canonicalPath);
          localStorage.setItem("kaggle_drive_current_path", canonicalPath);
        } catch (_) {}
      }
      AppState.files = data.items || [];
      this.renderBreadcrumb();
      this.renderFiles();
    } catch (err) {
      if (loadSequence !== this.directoryLoadSequence) return;
      UI.toast(`${t("error")}: ${err.message}`, "error");
    }
  },

  renderBreadcrumb() {
    const container = document.getElementById("breadcrumbContainer");
    if (!container) return;

    let html = `
      <span class="breadcrumb-crumb ${!AppState.currentPath ? 'active' : ''}" onclick="App.loadDirectory('', true)">
        <i class="fa-solid fa-house-chimney icon-python"></i> working
      </span>
    `;

    if (AppState.currentPath) {
      const parts = AppState.currentPath.split("/");
      let accum = "";
      parts.forEach((part, idx) => {
        accum = accum ? `${accum}/${part}` : part;
        const isLast = idx === parts.length - 1;
        html += `
          <span class="breadcrumb-sep"><i class="fa-solid fa-chevron-right" style="font-size: 10px;"></i></span>
          <span class="breadcrumb-crumb ${isLast ? 'active' : ''}" onclick="App.loadDirectory('${UI.inlineJsString(accum)}', true)">
            ${UI.escape(part)}
          </span>
        `;
      });
    }

    container.innerHTML = html;
  },

  getVisibleFiles() {
    if (!AppState.searchQuery) return AppState.files;
    return AppState.files.filter(f => f.name.toLowerCase().includes(AppState.searchQuery));
  },

  isTextEditableItem(item) {
    if (!item || item.is_dir) return false;
    const ext = (item.extension || "").toLowerCase();
    return (
      ["code", "text", "markdown"].includes(item.category) ||
      ["csv", "tsv"].includes(ext)
    ) && !["xlsx", "xls"].includes(ext);
  },

  renderFiles() {
    const container = document.getElementById("fileViewContainer");
    if (!container) return;

    const filtered = this.getVisibleFiles();

    if (!filtered.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div>
          <h3 style="font-weight: 600;">${t("empty_title")}</h3>
          <p style="margin-top: 6px; font-size: 13.5px;">${t("empty_desc")}</p>
        </div>
      `;
      return;
    }

    if (AppState.viewMode === "grid") {
      this.renderGridView(filtered, container);
    } else {
      this.renderListView(filtered, container);
    }
    this.updateSelectionUI();
  },

  renderGridView(items, container) {
    let html = '<div class="file-grid">';

    items.forEach(item => {
      const isSelected = AppState.selectedItems.has(item.path);
      const icon = UI.getIcon(item);
      const safePath = UI.inlineJsString(item.path);

      html += `
        <div class="file-card ${isSelected ? 'selected' : ''}" 
             data-path="${UI.escape(item.path)}"
             onclick="App.handleItemClick(event, '${safePath}')" 
             ondblclick="App.handleItemDblClick('${safePath}', ${item.is_dir})"
             oncontextmenu="App.handleContextMenu(event, '${safePath}')"
             title="${UI.escape(item.name)}">
          <div class="file-card-header">
            <div class="file-card-icon-wrapper">${icon}</div>
            <button class="file-card-menu-btn" onclick="App.openItemActionsModal(event, '${safePath}')" title="${t("options")}">
              <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
          </div>
          <div class="file-card-name">${UI.escape(item.name)}</div>
          <div class="file-card-meta">
            <span>${item.formatted_size}</span>
            <span>${item.mtime.split(" ")[0]}</span>
          </div>
        </div>
      `;
    });

    html += '</div>';
    container.innerHTML = html;
  },

  renderListView(items, container) {
    let html = `
      <div class="file-table-container">
        <table class="file-table">
          <thead>
            <tr>
              <th style="width: 38px;">
                <input type="checkbox" id="selectAllCheckbox" onchange="App.toggleSelectAll(this.checked)" ${AppState.selectedItems.size === items.length && items.length > 0 ? 'checked' : ''}>
              </th>
              <th>${t("col_name")}</th>
              <th style="width: 120px;">${t("col_size")}</th>
              <th style="width: 180px;">${t("col_date")}</th>
              <th style="width: 130px; text-align: right;">${t("col_actions")}</th>
            </tr>
          </thead>
          <tbody>
    `;

    items.forEach(item => {
      const isSelected = AppState.selectedItems.has(item.path);
      const icon = UI.getIcon(item);
      const safePath = UI.inlineJsString(item.path);

      html += `
        <tr class="${isSelected ? 'selected' : ''}" 
            data-path="${UI.escape(item.path)}"
            onclick="App.handleItemClick(event, '${safePath}')"
            ondblclick="App.handleItemDblClick('${safePath}', ${item.is_dir})"
            oncontextmenu="App.handleContextMenu(event, '${safePath}')">
          <td onclick="event.stopPropagation()">
            <input type="checkbox" class="item-checkbox" onchange="App.toggleItemSelection('${safePath}', this.checked)" ${isSelected ? 'checked' : ''}>
          </td>
          <td>
            <div class="table-file-name">
              <span style="font-size: 20px;">${icon}</span>
              <span>${UI.escape(item.name)}</span>
            </div>
          </td>
          <td>${item.formatted_size}</td>
          <td>${item.mtime}</td>
          <td>
            <div class="table-actions" onclick="event.stopPropagation()">
              ${!item.is_dir ? `
                <button class="table-btn-action" title="${t("action_download")}" onclick="App.downloadFile('${safePath}')"><i class="fa-solid fa-download"></i></button>
                <button class="table-btn-action" title="${t("action_preview")}" onclick="App.previewItem('${safePath}')"><i class="fa-solid fa-eye"></i></button>
                ${(item.extension || "").toLowerCase() === "sh" ? `
                  <button class="table-btn-action" title="${t("action_run_shell_script")}" onclick="App.runShellScript('${safePath}')"><i class="fa-solid fa-play"></i></button>
                ` : ''}
                ${this.isTextEditableItem(item) ? `
                  <button class="table-btn-action" title="${t("action_edit")}" onclick="Editor.openFile('${safePath}')"><i class="fa-solid fa-pen-to-square"></i></button>
                ` : ''}
              ` : `
                <button class="table-btn-action" title="${t("action_download_zip")}" onclick="App.downloadZip('${safePath}')"><i class="fa-solid fa-file-zipper"></i></button>
              `}
              <button class="table-btn-action" title="${t("more_options")}" onclick="App.openItemActionsModal(event, '${safePath}')"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            </div>
          </td>
        </tr>
      `;
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;
  },

  handleItemClick(event, path) {
    // If clicked inside interactive buttons (3-dots, action buttons, checkbox), let their handlers run
    if (event.target.closest("button") || event.target.closest("a") || event.target.closest("input[type='checkbox']")) {
      return;
    }

    this.hideContextMenu();

    const isMulti = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (isShift && AppState.lastSelectedPath) {
      const items = this.getVisibleFiles().map(f => f.path);
      const fromIdx = items.indexOf(AppState.lastSelectedPath);
      const toIdx = items.indexOf(path);
      if (fromIdx !== -1 && toIdx !== -1) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        if (!isMulti) AppState.selectedItems.clear();
        for (let i = start; i <= end; i++) {
          AppState.selectedItems.add(items[i]);
        }
      } else {
        AppState.selectedItems.clear();
        AppState.selectedItems.add(path);
      }
    } else if (isMulti) {
      if (AppState.selectedItems.has(path)) {
        AppState.selectedItems.delete(path);
      } else {
        AppState.selectedItems.add(path);
      }
      AppState.lastSelectedPath = path;
    } else {
      AppState.selectedItems.clear();
      AppState.selectedItems.add(path);
      AppState.lastSelectedPath = path;
    }

    this.updateSelectionUI();
  },

  handleItemDblClick(path, isDir) {
    this.hideContextMenu();

    if (isDir) {
      this.loadDirectory(path);
    } else {
      const item = AppState.files.find(f => f.path === path);
      if (!item) return;

      if (['code', 'text', 'markdown'].includes(item.category) && !['csv', 'tsv'].includes((item.extension || '').toLowerCase())) {
        Editor.openFile(path);
      } else {
        Previewer.openPreview(item);
      }
    }
  },

  handleContextMenu(event, path) {
    event.preventDefault();
    event.stopPropagation();

    // If right-clicked item is not currently selected, select it exclusively
    if (!AppState.selectedItems.has(path)) {
      AppState.selectedItems.clear();
      AppState.selectedItems.add(path);
      AppState.lastSelectedPath = path;
      this.updateSelectionUI();
    }

    if (window.innerWidth <= 640) {
      this.openItemActionsModal(event, path);
      return;
    }

    this.showContextMenuAt(event.clientX, event.clientY, path);
  },

  handleContainerContextMenu(event) {
    // If right-click originated on an item, item handler already stopped propagation
    if (event.target.closest(".file-card") || event.target.closest(".file-table tbody tr")) {
      return;
    }

    event.preventDefault();

    if (AppState.selectedItems.size > 0) {
      AppState.selectedItems.clear();
      AppState.lastSelectedPath = null;
      this.updateSelectionUI();
    }

    if (window.innerWidth <= 640) return;

    this.showContainerContextMenuAt(event.clientX, event.clientY);
  },

  handleContainerClick(event) {
    if (this._justDragged) {
      return;
    }
    if (!event.target.closest(".file-card") && 
        !event.target.closest(".file-table tbody tr") && 
        !event.target.closest("#contextMenu") &&
        !event.target.closest("button") &&
        !event.target.closest(".modal-content")) {
      if (AppState.selectedItems.size > 0) {
        AppState.selectedItems.clear();
        AppState.lastSelectedPath = null;
        this.updateSelectionUI();
      }
      this.hideContextMenu();
    }
  },

  updateSelectionUI() {
    // 1. Grid View cards
    const cards = document.querySelectorAll(".file-card");
    cards.forEach(card => {
      const p = card.getAttribute("data-path");
      if (p && AppState.selectedItems.has(p)) {
        card.classList.add("selected");
      } else {
        card.classList.remove("selected");
      }
      card.classList.toggle("cut-pending", this.isCutPending(p));
    });

    // 2. List View rows & checkboxes
    const rows = document.querySelectorAll(".file-table tbody tr");
    rows.forEach(row => {
      const p = row.getAttribute("data-path");
      const isSel = p && AppState.selectedItems.has(p);
      row.classList.toggle("selected", isSel);
      row.classList.toggle("cut-pending", this.isCutPending(p));
      const cb = row.querySelector(".item-checkbox");
      if (cb) cb.checked = isSel;
    });

    // 3. Table Header select-all checkbox
    const selectAllCb = document.getElementById("selectAllCheckbox");
    if (selectAllCb) {
      const visible = this.getVisibleFiles();
      const total = visible.length;
      const count = visible.filter(f => AppState.selectedItems.has(f.path)).length;
      selectAllCb.checked = total > 0 && count === total;
      selectAllCb.indeterminate = count > 0 && count < total;
    }

    // 4. Selection bar
    this.updateSelectionBar();
  },

  toggleItemSelection(path, checked) {
    if (checked === undefined) {
      if (AppState.selectedItems.has(path)) {
        AppState.selectedItems.delete(path);
      } else {
        AppState.selectedItems.add(path);
        AppState.lastSelectedPath = path;
      }
    } else if (checked) {
      AppState.selectedItems.add(path);
      AppState.lastSelectedPath = path;
    } else {
      AppState.selectedItems.delete(path);
    }
    this.updateSelectionUI();
  },

  toggleSelectAll(checked) {
    if (checked) {
      this.getVisibleFiles().forEach(f => AppState.selectedItems.add(f.path));
    } else {
      AppState.selectedItems.clear();
      AppState.lastSelectedPath = null;
    }
    this.updateSelectionUI();
  },

  clipboardSelection(path = null) {
    if (path && !AppState.selectedItems.has(path)) return [path];
    if (AppState.selectedItems.size) return Array.from(AppState.selectedItems);
    return path ? [path] : [];
  },

  copySelectedItems(path = null) {
    this.setFileClipboard("copy", this.clipboardSelection(path));
  },

  cutSelectedItems(path = null) {
    this.setFileClipboard("cut", this.clipboardSelection(path));
  },

  setFileClipboard(operation, paths) {
    const uniquePaths = [...new Set(paths)];
    if (!uniquePaths.length) {
      UI.toast(t("no_items_selected"), "warning");
      return;
    }

    AppState.fileClipboard = {
      operation,
      paths: uniquePaths,
    };
    this.updateFileClipboardBar();
    this.updateSelectionUI();
    UI.toast(t(operation === "cut" ? "clipboard_cut_ready" : "clipboard_copy_ready", {
      count: uniquePaths.length
    }), "success");
  },

  isCutPending(path) {
    const clipboard = AppState.fileClipboard;
    return Boolean(
      clipboard && clipboard.operation === "cut" &&
      clipboard.paths.includes(path)
    );
  },

  updateFileClipboardBar() {
    const bar = document.getElementById("fileClipboardBar");
    const status = document.getElementById("fileClipboardStatus");
    if (!bar) return;

    const clipboard = AppState.fileClipboard;
    if (!clipboard || !clipboard.paths.length) {
      bar.style.display = "none";
      return;
    }

    bar.style.display = "flex";
    if (status) {
      const key = clipboard.operation === "cut" ? "clipboard_cut_status" : "clipboard_copy_status";
      status.textContent = t(key, { count: clipboard.paths.length });
    }
  },

  clearFileClipboard() {
    AppState.fileClipboard = null;
    this.updateFileClipboardBar();
    this.updateSelectionUI();
  },

  createFileOperationControl(taskId) {
    return {
      taskId,
      operationId: null,
      completedOperationId: null,
      cancelRequested: false,
      cancelSent: false,
      awaitingConfirmation: false
    };
  },

  fileOperationCancelledError() {
    const error = new Error(t("operation_cancelled"));
    error.name = "AbortError";
    return error;
  },

  markFileOperationFinalizing(control) {
    control.cancelRequested = false;
    const task = UI.backgroundTasks.get(control.taskId);
    if (task) {
      task.cancelRequested = true;
      if (task.cancelButton) {
        const label = t("operation_finalizing");
        task.cancelButton.disabled = true;
        if (task.cancelLabel) task.cancelLabel.textContent = label;
        task.cancelButton.title = label;
        task.cancelButton.setAttribute("aria-label", label);
      }
    }
    UI.updateBackgroundTask(control.taskId, {
      detail: t("operation_finalizing")
    });
  },

  async cancelFileOperationTask(control) {
    control.cancelRequested = true;
    if (control.awaitingConfirmation) UI.resolveConfirmation(false);
    const operationId = control.operationId || control.completedOperationId;
    if (operationId && !control.cancelSent) {
      control.cancelSent = true;
      try {
        const state = await API.cancelFileOperation(operationId);
        if (state.status === "finalizing") {
          this.markFileOperationFinalizing(control);
        }
      } catch (error) {
        control.cancelSent = false;
        throw error;
      }
    }
  },

  async runFileOperationJob(operation, payload, control, detail, progress = null) {
    if (control.cancelRequested) throw this.fileOperationCancelledError();
    let operationId = null;
    try {
      const started = await API.startFileOperation(operation, payload);
      operationId = started.operation_id;
      control.operationId = operationId;
      if (control.cancelRequested && !control.cancelSent) {
        control.cancelSent = true;
        try {
          const cancellation = await API.cancelFileOperation(operationId);
          if (cancellation.status === "finalizing") {
            this.markFileOperationFinalizing(control);
          }
        } catch (_) {
          control.cancelSent = false;
        }
      }

      while (true) {
        if (control.cancelRequested && !control.cancelSent) {
          control.cancelSent = true;
          try {
            const cancellation = await API.cancelFileOperation(operationId);
            if (cancellation.status === "finalizing") {
              this.markFileOperationFinalizing(control);
            }
          } catch (_) {
            control.cancelSent = false;
          }
        }
        const state = await API.getFileOperation(operationId);
        if (state.status === "finalizing") {
          this.markFileOperationFinalizing(control);
        }
        if (state.status === "completed") return state.result;
        if (state.status === "failed") {
          const operationError = state.error || {};
          const errorDetail = operationError.detail;
          const message = (typeof errorDetail === "string"
            ? errorDetail
            : errorDetail && errorDetail.message) || t("error");
          const error = new Error(message);
          error.status = operationError.status_code;
          error.data = { detail: errorDetail };
          throw error;
        }
        if (state.status === "cancelled") {
          control.cancelRequested = true;
          throw this.fileOperationCancelledError();
        }

        UI.updateBackgroundTask(control.taskId, {
          detail: state.status === "cancelling"
            ? t("operation_canceling")
            : state.status === "finalizing"
              ? t("operation_finalizing")
              : detail,
          progress: Number.isFinite(state.progress) ? state.progress : progress
        });
        await new Promise(resolve => window.setTimeout(resolve, 350));
      }
    } catch (error) {
      if (operationId && control.operationId === operationId && !control.cancelSent) {
        control.cancelSent = true;
        try { await API.cancelFileOperation(operationId); } catch (_) {}
      }
      throw error;
    } finally {
      if (operationId) control.completedOperationId = operationId;
      if (!operationId || control.operationId === operationId) {
        control.operationId = null;
        control.cancelSent = false;
      }
    }
  },

  async pasteClipboard(targetFolder = AppState.currentPath) {
    const clipboard = AppState.fileClipboard;
    if (!clipboard || !clipboard.paths.length) {
      UI.toast(t("clipboard_empty"), "warning");
      return;
    }

    if (this.clipboardPasteInProgress) return;

    const targetPath = String(targetFolder || "").split("/").filter(Boolean).join("/");
    const pathsToPaste = clipboard.paths.filter(path => {
      if (clipboard.operation !== "cut") return true;
      const slash = path.lastIndexOf("/");
      const sourceFolder = slash < 0 ? "" : path.slice(0, slash);
      return sourceFolder !== targetPath;
    });
    if (!pathsToPaste.length) {
      UI.toast(t("clipboard_same_folder"), "info");
      return;
    }

    this.clipboardPasteInProgress = true;
    let control;
    const taskId = UI.startBackgroundTask(
      t(clipboard.operation === "cut" ? "clipboard_moving" : "clipboard_copying"),
      t("clipboard_operation_progress", {
        current: 0,
        total: pathsToPaste.length,
        name: ""
      }),
      0,
      () => this.cancelFileOperationTask(control)
    );
    control = this.createFileOperationControl(taskId);
    try {
      const succeeded = [];
      const failed = [];
      for (let index = 0; index < pathsToPaste.length; index++) {
        if (control.cancelRequested) break;
        const sourcePath = pathsToPaste[index];
        const name = sourcePath.split("/").pop() || sourcePath;
        UI.updateBackgroundTask(taskId, {
          detail: t("clipboard_operation_progress", {
            current: index + 1,
            total: pathsToPaste.length,
            name
          }),
          progress: (index / pathsToPaste.length) * 100
        });
        try {
          await this.runFileOperationJob(
            clipboard.operation === "cut" ? "move" : "copy",
            { source_path: sourcePath, target_folder: targetPath },
            control,
            t("clipboard_operation_progress", {
              current: index + 1,
              total: pathsToPaste.length,
              name
            }),
            (index / pathsToPaste.length) * 100
          );
          succeeded.push(sourcePath);
        } catch (error) {
          if (error && error.name === "AbortError") break;
          failed.push(error);
        }
        UI.updateBackgroundTask(taskId, {
          progress: ((index + 1) / pathsToPaste.length) * 100
        });
      }

      if (clipboard.operation === "cut" && succeeded.length) {
        const completed = new Set(succeeded);
        const remaining = clipboard.paths.filter(path => !completed.has(path));
        AppState.fileClipboard = remaining.length ? { ...clipboard, paths: remaining } : null;
        this.updateFileClipboardBar();
        this.updateSelectionUI();
      }

      if (succeeded.length) {
        if (AppState.currentPath === targetPath) {
          await this.loadDirectory(targetPath, false);
        }
        this.refreshSystemStats();
      }
      if (control.cancelRequested) {
        UI.toast(t("operation_cancelled"), "info", 5000);
      } else if (failed.length) {
        UI.toast(t("clipboard_paste_partial", {
          success: succeeded.length,
          failed: failed.length
        }), succeeded.length ? "warning" : "error", 5000);
        UI.toast(failed[0].message || t("error"), "error", 5000);
      } else if (succeeded.length) {
        UI.toast(t("clipboard_pasted", { count: succeeded.length }), "success");
      }
    } finally {
      this.clipboardPasteInProgress = false;
      UI.finishBackgroundTask(taskId);
    }
  },

  showContextMenuAt(x, y, path) {
    const menu = document.getElementById("contextMenu");
    const header = document.getElementById("contextMenuHeader");
    const body = document.getElementById("contextMenuItems");
    if (!menu || !body) return;

    const count = AppState.selectedItems.size;
    const isMultiple = count > 1 && AppState.selectedItems.has(path);

    if (isMultiple) {
      if (header) {
        header.style.display = "block";
        header.innerHTML = `<div class="context-menu-caption">${t("selected_items", { count })}</div>`;
      }

      body.innerHTML = `
        <button class="context-menu-item" onclick="App.hideContextMenu(); App.copySelectedItems()">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-solid fa-copy"></i></span>
            <span>${t("file_copy")}</span>
          </div>
          <span class="context-item-kbd">Ctrl+C</span>
        </button>
        <button class="context-menu-item" onclick="App.hideContextMenu(); App.cutSelectedItems()">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-solid fa-scissors"></i></span>
            <span>${t("file_cut")}</span>
          </div>
          <span class="context-item-kbd">Ctrl+X</span>
        </button>
        <div class="context-menu-divider"></div>
        <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptCompress()">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-solid fa-box-archive"></i></span>
            <span>${t("action_compress_selected")}</span>
          </div>
        </button>
        <button class="context-menu-item" onclick="App.hideContextMenu(); App.downloadSelectedAsZip()">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-solid fa-file-zipper"></i></span>
            <span>${t("download_selected_zip")}</span>
          </div>
        </button>
        <div class="context-menu-divider"></div>
        <button class="context-menu-item danger" onclick="App.hideContextMenu(); App.promptDelete()">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-regular fa-trash-can"></i></span>
            <span>${t("delete_selected")} (${count})</span>
          </div>
          <span class="context-item-kbd">Del</span>
        </button>
      `;
    } else {
      const item = AppState.files.find(f => f.path === path);
      if (!item) return;

      // Clean desktop style: hide bulky duplicate header
      if (header) {
        header.style.display = "none";
        header.innerHTML = "";
      }

      const safePath = UI.inlineJsString(path);
      let itemsHtml = "";

      if (item.is_dir) {
        itemsHtml += `
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.loadDirectory('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-folder-open"></i></span>
              <span>${t("action_open_folder")}</span>
            </div>
            <span class="context-item-kbd">Enter</span>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.openTerminalModal('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-terminal"></i></span>
              <span>${t("action_open_terminal")}</span>
            </div>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.copyFilePath('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-folder-tree"></i></span>
              <span>${t("action_copy_path")}</span>
            </div>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptCompress('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-box-archive"></i></span>
              <span>${t("action_compress")}</span>
            </div>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.downloadZip('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-file-zipper"></i></span>
              <span>${t("action_download_zip")}</span>
            </div>
          </button>
          <div class="context-menu-divider"></div>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptRename('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-pen-to-square"></i></span>
              <span>${t("action_rename")}</span>
            </div>
            <span class="context-item-kbd">F2</span>
          </button>
          <div class="context-menu-divider"></div>
          <button class="context-menu-item danger" onclick="App.hideContextMenu(); App.promptDelete('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-trash-can"></i></span>
              <span>${t("action_delete")}</span>
            </div>
            <span class="context-item-kbd">Del</span>
          </button>
        `;
      } else {
        const isSpreadsheet = ['spreadsheet', 'csv'].includes(item.category) || ['xlsx', 'xls', 'csv', 'tsv'].includes((item.extension || '').toLowerCase());
        const isEditable = this.isTextEditableItem(item);
        const isArchive = ['zip', 'tar', 'archive'].includes(item.category) || ['zip', 'tar', 'gz', 'bz2', 'rar'].includes((item.extension || '').toLowerCase());
        const isShellScript = (item.extension || '').toLowerCase() === 'sh';

        let primaryIcon = 'fa-regular fa-eye';
        let primaryLabel = t("action_preview");
        if (item.category === "image") {
          primaryIcon = 'fa-regular fa-image';
          primaryLabel = t("action_view_image");
        } else if (item.category === "video") {
          primaryIcon = 'fa-solid fa-circle-play';
          primaryLabel = t("action_play_video");
        } else if (item.category === "audio") {
          primaryIcon = 'fa-solid fa-music';
          primaryLabel = t("action_play_audio");
        } else if (item.category === "pdf") {
          primaryIcon = 'fa-regular fa-file-pdf';
          primaryLabel = t("action_view_pdf");
        } else if (isSpreadsheet) {
          const isXls = ['xlsx', 'xls'].includes((item.extension || '').toLowerCase());
          primaryIcon = isXls ? 'fa-solid fa-file-excel' : 'fa-solid fa-table';
          primaryLabel = isXls ? t("action_view_excel") : t("action_view_csv");
        }

        if (isShellScript) {
          itemsHtml += `
            <button class="context-menu-item" onclick="App.hideContextMenu(); App.runShellScript('${safePath}')">
              <div class="context-item-left">
                <span class="context-item-icon"><i class="fa-solid fa-play"></i></span>
                <span>${t("action_run_shell_script")}</span>
              </div>
            </button>
          `;
        }

        if (isEditable) {
          itemsHtml += `
            <button class="context-menu-item" onclick="App.hideContextMenu(); Editor.openFile('${safePath}')">
              <div class="context-item-left">
                <span class="context-item-icon"><i class="fa-regular fa-pen-to-square"></i></span>
                <span>${t("action_edit")}</span>
              </div>
              <span class="context-item-kbd">Enter</span>
            </button>
            <button class="context-menu-item" onclick="App.hideContextMenu(); App.previewItem('${safePath}')">
              <div class="context-item-left">
                <span class="context-item-icon"><i class="fa-regular fa-eye"></i></span>
                <span>${t("action_preview")}</span>
              </div>
              <span class="context-item-kbd">Space</span>
            </button>
          `;
        } else {
          itemsHtml += `
            <button class="context-menu-item" onclick="App.hideContextMenu(); App.previewItem('${safePath}')">
              <div class="context-item-left">
                <span class="context-item-icon"><i class="${primaryIcon}"></i></span>
                <span>${primaryLabel}</span>
              </div>
              <span class="context-item-kbd">Space</span>
            </button>
          `;
        }

        itemsHtml += `
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.downloadFile('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-download"></i></span>
              <span>${t("action_download")}</span>
            </div>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.copyFilePath('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-folder-tree"></i></span>
              <span>${t("action_copy_path")}</span>
            </div>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptCompress('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-box-archive"></i></span>
              <span>${t("action_compress")}</span>
            </div>
          </button>
        `;

        if (isArchive) {
          itemsHtml += `
            <button class="context-menu-item" onclick="App.hideContextMenu(); App.extractArchive('${safePath}')">
              <div class="context-item-left">
                <span class="context-item-icon"><i class="fa-solid fa-box-open"></i></span>
                <span>${t("action_extract_here")}</span>
              </div>
            </button>
          `;
        }

        itemsHtml += `
          <div class="context-menu-divider"></div>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptRename('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-pen-to-square"></i></span>
              <span>${t("action_rename")}</span>
            </div>
            <span class="context-item-kbd">F2</span>
          </button>
          <div class="context-menu-divider"></div>
          <button class="context-menu-item danger" onclick="App.hideContextMenu(); App.promptDelete('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-trash-can"></i></span>
              <span>${t("action_delete")}</span>
            </div>
            <span class="context-item-kbd">Del</span>
          </button>
        `;
      }
      itemsHtml = `
        <button class="context-menu-item" onclick="App.hideContextMenu(); App.copySelectedItems('${safePath}')">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-solid fa-copy"></i></span>
            <span>${t("file_copy")}</span>
          </div>
          <span class="context-item-kbd">Ctrl+C</span>
        </button>
        <button class="context-menu-item" onclick="App.hideContextMenu(); App.cutSelectedItems('${safePath}')">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-solid fa-scissors"></i></span>
            <span>${t("file_cut")}</span>
          </div>
          <span class="context-item-kbd">Ctrl+X</span>
        </button>
        ${item.is_dir && AppState.fileClipboard ? `
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.pasteClipboard('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-paste"></i></span>
              <span>${t("file_paste")}</span>
            </div>
            <span class="context-item-kbd">Ctrl+V</span>
          </button>
        ` : ""}
        <div class="context-menu-divider"></div>
      ` + itemsHtml;
      body.innerHTML = itemsHtml;
    }

    this.positionContextMenu(x, y);
  },

  showContainerContextMenuAt(x, y) {
    const menu = document.getElementById("contextMenu");
    const header = document.getElementById("contextMenuHeader");
    const body = document.getElementById("contextMenuItems");
    if (!menu || !body) return;

    if (header) {
      header.style.display = "none";
      header.innerHTML = "";
    }

    body.innerHTML = `
      ${AppState.fileClipboard ? `
        <button class="context-menu-item" onclick="App.hideContextMenu(); App.pasteClipboard()">
          <div class="context-item-left">
            <span class="context-item-icon"><i class="fa-solid fa-paste"></i></span>
            <span>${t("file_paste")}</span>
          </div>
          <span class="context-item-kbd">Ctrl+V</span>
        </button>
        <div class="context-menu-divider"></div>
      ` : ""}
      <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptNewFolder()">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-folder-plus"></i></span>
          <span>${t("new_folder")}</span>
        </div>
      </button>
      <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptNewFile()">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-file-circle-plus"></i></span>
          <span>${t("new_file")}</span>
        </div>
      </button>
      <div class="context-menu-divider"></div>
      <button class="context-menu-item" onclick="App.hideContextMenu(); App.openTerminalModal(AppState.currentPath)">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-terminal"></i></span>
          <span>${t("action_open_terminal_here")}</span>
        </div>
      </button>
      <div class="context-menu-divider"></div>
      <button class="context-menu-item" onclick="App.hideContextMenu(); document.getElementById('fileInput').click()">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-arrow-up-from-bracket"></i></span>
          <span>${t("upload_file")}</span>
        </div>
      </button>
      <button class="context-menu-item" onclick="App.hideContextMenu(); document.getElementById('folderInput').click()">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-folder-plus"></i></span>
          <span>${t("upload_folder")}</span>
        </div>
      </button>
      <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptDownloadUrl()">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-cloud-arrow-down"></i></span>
          <span>${t("upload_url")}</span>
        </div>
      </button>
      <div class="context-menu-divider"></div>
      <button class="context-menu-item" onclick="App.hideContextMenu(); App.loadDirectory(AppState.currentPath, false)">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-rotate"></i></span>
          <span>${t("refresh")}</span>
        </div>
        <span class="context-item-kbd">F5</span>
      </button>
      <button class="context-menu-item" onclick="App.hideContextMenu(); App.downloadZip()">
        <div class="context-item-left">
          <span class="context-item-icon"><i class="fa-solid fa-file-zipper"></i></span>
          <span>${t("download_folder_zip")}</span>
        </div>
      </button>
    `;

    this.positionContextMenu(x, y);
  },

  positionContextMenu(x, y) {
    const menu = document.getElementById("contextMenu");
    if (!menu) return;

    menu.style.visibility = "hidden";
    menu.classList.remove("hidden");

    const rect = menu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    let left = x;
    let top = y;

    if (left + rect.width > winW - 8) {
      left = Math.max(8, winW - rect.width - 8);
    }
    if (top + rect.height > winH - 8) {
      top = Math.max(8, winH - rect.height - 8);
    }
    if (left < 8) left = 8;
    if (top < 8) top = 8;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
  },

  hideContextMenu() {
    const menu = document.getElementById("contextMenu");
    if (menu) {
      menu.classList.add("hidden");
    }
  },

  clearSelection() {
    AppState.selectedItems.clear();
    AppState.lastSelectedPath = null;
    this.updateSelectionUI();
  },

  updateSelectionBar() {
    const bar = document.getElementById("selectionBar");
    const countEl = document.getElementById("selectedCountText");
    if (!bar) return;

    const count = AppState.selectedItems.size;
    // Only display selection bar for batch operations (2 or more items selected)
    // Clicking a single item highlights it like File Explorer without popping up the bar
    if (count > 1) {
      bar.classList.add("show");
      if (countEl) countEl.textContent = t("selected_items", { count });
    } else {
      bar.classList.remove("show");
    }
  },

  toggleViewMode() {
    AppState.viewMode = AppState.viewMode === "grid" ? "list" : "grid";
    localStorage.setItem("kaggle_drive_view_mode", AppState.viewMode);
    const btn = document.getElementById("btnToggleView");
    if (btn) btn.innerHTML = AppState.viewMode === "grid" ? '<i class="fa-solid fa-list"></i>' : '<i class="fa-solid fa-table-cells-large"></i>';
    this.renderFiles();
  },

  toggleShowHidden() {
    AppState.showHidden = !AppState.showHidden;
    const btn = document.getElementById("btnToggleHidden");
    if (btn) btn.style.color = AppState.showHidden ? "var(--primary)" : "var(--text-muted)";
    this.loadDirectory(AppState.currentPath, false);
  },

  goBack() {
    if (AppState.parentPath !== null) {
      this.loadDirectory(AppState.parentPath);
    }
  },

  downloadFile(path) {
    this.hideContextMenu();
    window.location.href = `/api/files/download?path=${encodeURIComponent(path)}`;
  },

  async downloadZip(path = "") {
    this.hideContextMenu();
    const targetPath = path || AppState.currentPath;
    const folderName = targetPath.split("/").filter(Boolean).pop() || "kaggle_working";
    const filename = `${folderName}.zip`;
    let control;
    const taskId = UI.startBackgroundTask(
      t("download_folder_zip"),
      t("background_operation_running"),
      null,
      () => this.cancelFileOperationTask(control)
    );
    control = this.createFileOperationControl(taskId);
    try {
      await this.runFileOperationJob(
        "download_folder_zip",
        { path: targetPath },
        control,
        t("background_operation_running")
      );
      if (control.cancelRequested) throw this.fileOperationCancelledError();
      await API.downloadFileOperationZip(
        control.completedOperationId,
        filename
      );
    } catch (error) {
      if (error && (error.name === "AbortError" || control.cancelRequested)) {
        UI.toast(t("operation_cancelled"), "info", 5000);
      } else {
        UI.toast(`${t("error")}: ${error.message}`, "error");
      }
    } finally {
      UI.finishBackgroundTask(taskId);
    }
  },

  previewItem(path) {
    this.hideContextMenu();
    const item = AppState.files.find(f => f.path === path);
    if (item) {
      Previewer.openPreview(item);
    } else {
      Previewer.openPreview(path);
    }
  },

  // Modal Dialog Actions
  promptNewFolder() {
    const input = document.getElementById("newFolderNameInput");
    if (input) input.value = "";
    UI.openModal("newFolderModal");
  },

  async confirmCreateFolder() {
    const input = document.getElementById("newFolderNameInput");
    const name = input.value.trim();
    if (!name) return;

    const fullPath = AppState.currentPath ? `${AppState.currentPath}/${name}` : name;
    try {
      await API.createFolder(fullPath);
      UI.closeModal("newFolderModal");
      UI.toast(t("folder_created_toast", { name }), "success");
      this.loadDirectory(AppState.currentPath, false);
      this.refreshSystemStats();
    } catch (err) {
      UI.toast(err.message, "error");
    }
  },

  promptNewFile() {
    const input = document.getElementById("newFileNameInput");
    if (input) input.value = "";
    UI.openModal("newFileModal");
  },

  async confirmCreateFile() {
    const input = document.getElementById("newFileNameInput");
    const name = input.value.trim();
    if (!name) return;

    const fullPath = AppState.currentPath ? `${AppState.currentPath}/${name}` : name;
    try {
      await API.createFile(fullPath);
      UI.closeModal("newFileModal");
      UI.toast(t("file_created_toast", { name }), "success");
      this.loadDirectory(AppState.currentPath, false);
      Editor.openFile(fullPath);
    } catch (err) {
      UI.toast(err.message, "error");
    }
  },

  promptDownloadUrl() {
    const urlInput = document.getElementById("downloadUrlInput");
    const nameInput = document.getElementById("downloadFilenameInput");
    if (urlInput) urlInput.value = "";
    if (nameInput) nameInput.value = "";
    UI.openModal("downloadUrlModal");
  },

  async confirmDownloadUrl() {
    const urlInput = document.getElementById("downloadUrlInput");
    const nameInput = document.getElementById("downloadFilenameInput");
    const btn = document.getElementById("btnStartDownloadUrl");

    const url = urlInput ? urlInput.value.trim() : "";
    const filename = nameInput ? nameInput.value.trim() : "";

    if (!url) {
      UI.toast(t("url_invalid_toast"), "warning");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = t("url_btn_downloading");
    }

    UI.toast(t("url_start_toast"), "info", 5000);

    try {
      let res;
      try {
        res = await API.downloadFromUrl(url, AppState.currentPath, filename || null);
      } catch (error) {
        const detail = error && error.data && error.data.detail;
        if (error.status !== 409 || !detail || detail.code !== "overwrite_required") throw error;
        const confirmed = await UI.confirmOverwrite(detail.paths || [], detail.count);
        if (!confirmed) return;
        res = await API.downloadFromUrl(url, AppState.currentPath, filename || null, true);
      }
      UI.closeModal("downloadUrlModal");
      UI.toast(res.message || t("success"), "success");
      this.loadDirectory(AppState.currentPath, false);
      this.refreshSystemStats();
    } catch (err) {
      UI.toast(`${t("error")}: ${err.message}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t("url_btn_start");
      }
    }
  },

  async downloadSelectedAsZip() {
    const items = Array.from(AppState.selectedItems);
    if (!items.length) {
      UI.toast(t("no_items_selected"), "warning");
      return;
    }
    let control;
    const taskId = UI.startBackgroundTask(
      t("compressing_multi_toast", { count: items.length }),
      t("background_operation_running"),
      null,
      () => this.cancelFileOperationTask(control)
    );
    control = this.createFileOperationControl(taskId);
    try {
      await this.runFileOperationJob(
        "download_selected_zip",
        { items },
        control,
        t("background_operation_running")
      );
      if (control.cancelRequested) throw this.fileOperationCancelledError();
      await API.downloadFileOperationZip(
        control.completedOperationId
      );
      UI.toast(t("compress_multi_success"), "success");
    } catch (err) {
      if (err && (err.name === "AbortError" || control.cancelRequested)) {
        UI.toast(t("operation_cancelled"), "info", 5000);
      } else {
        UI.toast(`${t("error")}: ${err.message}`, "error");
      }
    } finally {
      UI.finishBackgroundTask(taskId);
    }
  },

  promptRename(path) {
    this.hideContextMenu();
    const targetPath = path || Array.from(AppState.selectedItems)[0];
    if (!targetPath) return;

    const filename = targetPath.split("/").pop();
    const input = document.getElementById("renameInput");
    document.getElementById("renamePathTarget").value = targetPath;
    if (input) input.value = filename;

    UI.openModal("renameModal");
  },

  async confirmRename() {
    const targetPath = document.getElementById("renamePathTarget").value;
    const input = document.getElementById("renameInput");
    const newName = input.value;
    if (!targetPath || !newName) return;

    try {
      await API.renameItem(targetPath, newName);
      UI.closeModal("renameModal");
      UI.toast(t("rename_success_toast"), "success");
      this.loadDirectory(AppState.currentPath, false);
    } catch (err) {
      UI.toast(err.message, "error");
    }
  },

  async promptDelete(path = null) {
    this.hideContextMenu();
    const itemsToDelete = path ? [path] : Array.from(AppState.selectedItems);
    if (!itemsToDelete.length) return;

    const message = itemsToDelete.length === 1
      ? t("delete_confirm_single")
      : t("delete_confirm_multi", { count: itemsToDelete.length });
    const confirmed = await UI.confirm({
      title: t("delete_modal_title"),
      message,
      confirmText: t("delete_btn_permanent"),
      confirmIcon: "fa-trash-can"
    });
    if (confirmed) await this.confirmDelete(itemsToDelete);
  },

  async confirmDelete(items) {
    if (!Array.isArray(items) || !items.length) return;
    let successCount = 0;
    let attempted = false;
    const deletedPaths = new Set();
    let control;
    const taskId = UI.startBackgroundTask(
      t("delete_in_progress"),
      t("clipboard_operation_progress", {
        current: 0,
        total: items.length,
        name: ""
      }),
      0,
      () => this.cancelFileOperationTask(control)
    );
    control = this.createFileOperationControl(taskId);

    try {
      for (let index = 0; index < items.length; index++) {
        if (control.cancelRequested) break;
        const itemPath = items[index];
        const name = itemPath.split("/").pop() || itemPath;
        UI.updateBackgroundTask(taskId, {
          detail: t("clipboard_operation_progress", {
            current: index + 1,
            total: items.length,
            name
          }),
          progress: (index / items.length) * 100
        });
        try {
          attempted = true;
          await this.runFileOperationJob(
            "delete",
            { path: itemPath },
            control,
            t("clipboard_operation_progress", {
              current: index + 1,
              total: items.length,
              name
            }),
            (index / items.length) * 100
          );
          successCount++;
          deletedPaths.add(itemPath);
        } catch (err) {
          if (err && err.name === "AbortError") break;
          UI.toast(`${t("error")} (${itemPath}): ${err.message}`, "error");
        }
        UI.updateBackgroundTask(taskId, {
          progress: ((index + 1) / items.length) * 100
        });
      }

      if (successCount > 0) {
        UI.toast(t("delete_success_toast", { count: successCount }), "success");
        deletedPaths.forEach(itemPath => AppState.selectedItems.delete(itemPath));
        this.updateSelectionUI();
      }
      if (control.cancelRequested) {
        UI.toast(t("operation_cancelled"), "info", 5000);
      }
      if (successCount > 0 || attempted) {
        this.loadDirectory(AppState.currentPath, false);
        this.refreshSystemStats();
      }
    } finally {
      UI.finishBackgroundTask(taskId);
    }
  },

  promptCompress(path = null) {
    this.hideContextMenu();
    const itemsToCompress = path ? [path] : Array.from(AppState.selectedItems);
    if (!itemsToCompress.length) {
      UI.toast(t("no_items_selected"), "warning");
      return;
    }

    const targetInput = document.getElementById("compressTargetPaths");
    const nameInput = document.getElementById("compressNameInput");
    if (targetInput) targetInput.value = JSON.stringify(itemsToCompress);

    let defaultName = "archive.zip";
    if (itemsToCompress.length === 1) {
      const base = itemsToCompress[0].split("/").pop().replace(/\.[^/.]+$/, "");
      defaultName = (base || "archive") + ".zip";
    }
    if (nameInput) {
      nameInput.value = defaultName;
      setTimeout(() => {
        nameInput.focus();
        nameInput.select();
      }, 50);
    }
    UI.openModal("compressModal");
  },

  async confirmCompress() {
    const targetsStr = document.getElementById("compressTargetPaths")?.value;
    const nameInput = document.getElementById("compressNameInput");
    if (!targetsStr) return;

    let paths = [];
    try {
      paths = JSON.parse(targetsStr);
    } catch {
      return;
    }
    if (!paths.length) return;

    const archiveName = nameInput ? nameInput.value.trim() : "";
    const targetFolder = AppState.currentPath;
    UI.closeModal("compressModal");
    let control;
    const taskId = UI.startBackgroundTask(
      t("compress_start_toast"),
      t("background_operation_running"),
      null,
      () => this.cancelFileOperationTask(control)
    );
    control = this.createFileOperationControl(taskId);

    try {
      const res = await this.runFileOperationJob(
        "compress",
        { paths, archive_name: archiveName, target_folder: targetFolder },
        control,
        t("background_operation_running")
      );
      UI.toast(t("compress_success_toast", { name: res.archive_name || archiveName || "archive.zip" }), "success");
      paths.forEach(path => AppState.selectedItems.delete(path));
      this.updateSelectionUI();
      if (AppState.currentPath === targetFolder) {
        this.loadDirectory(targetFolder, false);
      }
      this.refreshSystemStats();
    } catch (err) {
      if (err && err.name === "AbortError") {
        UI.toast(t("operation_cancelled"), "info", 5000);
      } else {
        UI.toast(`${t("error")}: ${err.message}`, "error");
      }
    } finally {
      UI.finishBackgroundTask(taskId);
    }
  },

  async extractArchive(path) {
    const targetPath = path || Array.from(AppState.selectedItems)[0];
    if (!targetPath) return;

    const initialViewPath = AppState.currentPath;
    let control;
    const taskId = UI.startBackgroundTask(
      t("extract_start_toast"),
      t("background_operation_running"),
      null,
      () => this.cancelFileOperationTask(control)
    );
    control = this.createFileOperationControl(taskId);
    try {
      let res;
      try {
        res = await this.runFileOperationJob(
          "extract", { path: targetPath }, control,
          t("background_operation_running")
        );
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        let detail = error && error.data && error.data.detail;
        if (error.status !== 409 || !detail || detail.code !== "overwrite_required") throw error;

        control.awaitingConfirmation = true;
        let mode;
        try {
          mode = await UI.chooseOverwriteMode(detail.paths || [], detail.count || 0);
        } finally {
          control.awaitingConfirmation = false;
        }
        if (control.cancelRequested) throw this.fileOperationCancelledError();
        if (mode === "all") {
          res = await this.runFileOperationJob(
            "extract", { path: targetPath, overwrite: true }, control,
            t("background_operation_running")
          );
        } else if (mode === "review") {
          if ((detail.count || 0) > 1000) {
            UI.toast(t("overwrite_review_unavailable"), "warning", 5000);
            return;
          }

          const overwritePaths = [];
          const skipPaths = [];
          let conflicts = detail.paths || [];

          while (true) {
            for (const conflictPath of conflicts) {
              control.awaitingConfirmation = true;
              let decision;
              try {
                decision = await UI.confirmOverwriteFile(conflictPath);
              } finally {
                control.awaitingConfirmation = false;
              }
              if (control.cancelRequested) throw this.fileOperationCancelledError();
              if (decision === false) return;
              if (decision === "overwrite") overwritePaths.push(conflictPath);
              else skipPaths.push(conflictPath);
            }

            try {
              res = await this.runFileOperationJob(
                "extract",
                {
                  path: targetPath,
                  overwrite_paths: overwritePaths,
                  skip_paths: skipPaths
                },
                control,
                t("background_operation_running")
              );
              break;
            } catch (nextError) {
              const nextDetail = nextError && nextError.data && nextError.data.detail;
              if (
                nextError.status !== 409 ||
                !nextDetail ||
                nextDetail.code !== "overwrite_required"
              ) {
                throw nextError;
              }
              if ((nextDetail.count || 0) > (nextDetail.paths || []).length) {
                UI.toast(t("overwrite_review_unavailable"), "warning", 5000);
                return;
              }
              detail = nextDetail;
              conflicts = detail.paths || [];
              if (!conflicts.length) throw nextError;
            }
          }
        } else {
          return;
        }
      }
      UI.toast(res.message || t("extract_success_toast"), "success");
      if (AppState.currentPath === initialViewPath) {
        this.loadDirectory(initialViewPath, false);
      }
      this.refreshSystemStats();
    } catch (err) {
      if (err && err.name === "AbortError") {
        UI.toast(t("operation_cancelled"), "info", 5000);
      } else {
        UI.toast(err.message, "error");
      }
    } finally {
      UI.finishBackgroundTask(taskId);
    }
  },

  openItemActionsModal(event, path) {
    if (event) {
      event.stopPropagation();
    }
    const item = AppState.files.find(f => f.path === path);
    if (!item) return;

    if (!AppState.selectedItems.has(path)) {
      AppState.selectedItems.clear();
      AppState.selectedItems.add(path);
      AppState.lastSelectedPath = path;
      this.updateSelectionUI();
    }

    // On desktop, anchor context menu right below the button
    if (window.innerWidth > 640 && event && event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      this.showContextMenuAt(rect.right - 200, rect.bottom + 4, path);
      return;
    }

    const modal = document.getElementById("itemActionsModal");
    const title = document.getElementById("itemActionsTitle");
    const content = document.getElementById("itemActionsContent");

    if (title) title.textContent = item.name;

    const safePath = UI.inlineJsString(path);
    let actions = `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.copySelectedItems('${safePath}')">
            <i class="fa-solid fa-copy"></i> ${t("file_copy")}
          </button>
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.cutSelectedItems('${safePath}')">
            <i class="fa-solid fa-scissors"></i> ${t("file_cut")}
          </button>
        </div>
        ${item.is_dir && AppState.fileClipboard ? `
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.pasteClipboard('${safePath}')">
            <i class="fa-solid fa-paste"></i> ${t("file_paste")}
          </button>
        ` : ""}
        ${!item.is_dir ? `
          ${(item.extension || "").toLowerCase() === "sh" ? `
            <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.runShellScript('${safePath}')">
              <i class="fa-solid fa-play"></i> ${t("action_run_shell_script")}
            </button>
          ` : ''}
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.downloadFile('${safePath}')">
            <i class="fa-solid fa-download"></i> ${t("action_download")}
          </button>
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.previewItem('${safePath}')">
            <i class="fa-solid fa-eye"></i> ${t("action_preview")}
          </button>
          ${this.isTextEditableItem(item) ? `
            <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); Editor.openFile('${safePath}')">
              <i class="fa-solid fa-pen-to-square"></i> ${t("action_edit")}
            </button>
          ` : ''}
          ${['zip', 'tar', 'archive'].includes(item.category) || ['zip', 'tar', 'gz', 'bz2', 'rar'].includes((item.extension || '').toLowerCase()) ? `
            <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.extractArchive('${safePath}')">
              <i class="fa-solid fa-box-open"></i> ${t("action_extract_here")}
            </button>
          ` : ''}
        ` : `
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.loadDirectory('${safePath}')">
            <i class="fa-solid fa-folder-open"></i> ${t("action_open_folder")}
          </button>
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.openTerminalModal('${safePath}')">
            <i class="fa-solid fa-terminal text-sky-500"></i> ${t("action_open_terminal")}
          </button>
          <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.downloadZip('${safePath}')">
            <i class="fa-solid fa-file-zipper"></i> ${t("action_download_zip")}
          </button>
        `}
        <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.copyFilePath('${safePath}')">
          <i class="fa-solid fa-folder-tree text-sky-500"></i> ${t("action_copy_path")}
        </button>
        <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.promptCompress('${safePath}')">
          <i class="fa-solid fa-box-archive text-amber-500"></i> ${t("action_compress")}
        </button>
        <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.promptRename('${safePath}')">
          <i class="fa-solid fa-tag"></i> ${t("action_rename")}
        </button>
        <button class="btn-danger" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.promptDelete('${safePath}')">
          <i class="fa-solid fa-trash-can"></i> ${t("action_delete")}
        </button>
      </div>
    `;

    if (content) content.innerHTML = actions;
    UI.openModal("itemActionsModal");
  },

  async copyFilePath(path) {
    this.hideContextMenu();
    const configuredRoot = String(AppState.rootDir || "");
    const windowsRoot = /^[a-z]:[\\/]/i.test(configuredRoot) || configuredRoot.startsWith("\\\\");
    const separator = windowsRoot ? "\\" : "/";
    const root = windowsRoot
      ? configuredRoot.replace(/\//g, "\\").replace(/\\+$/, "")
      : configuredRoot.replace(/\/+$/, "");
    const relativePath = windowsRoot
      ? String(path || "").replace(/\//g, "\\").replace(/^\\+/, "")
      : String(path || "").replace(/^\/+/, "");
    const fullPath = relativePath ? `${root}${separator}${relativePath}` : (root || separator);

    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(fullPath);
      UI.toast(t("path_copied_toast"), "success");
    } catch (_) {
      prompt(t("copy_path_prompt"), fullPath);
    }
  },

  copyDownloadCommand(path) {
    this.copyFilePath(path);
  },

  // System Stats & Terminal
  async refreshSystemStats(showToast = false) {
    const btn = document.getElementById("btnRefreshStats");
    const modal = document.getElementById("systemStatsModal");
    const body = document.getElementById("systemStatsBody");
    let originalIcon = null;
    if (btn && showToast) {
      originalIcon = btn.innerHTML;
      btn.innerHTML = `<i class="fa-solid fa-rotate fa-spin"></i> ${t("stats_refreshing")}`;
      btn.disabled = true;
    }
    if (!AppState.systemStats && body && modal && modal.classList.contains("show")) {
      body.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
          <i class="fa-solid fa-circle-notch fa-spin text-3xl text-brand-600"></i>
          <span class="text-sm font-medium text-slate-600">${t("stats_scanning")}</span>
        </div>
      `;
    }

    try {
      const stats = await API.getSystemStats();
      AppState.systemStats = stats;

      if (stats.disk) {
        const percent = stats.disk.status !== "unavailable" && Number.isFinite(stats.disk.percent)
          ? stats.disk.percent
          : null;
        const fill = document.getElementById("sidebarStorageFill");
        const text = document.getElementById("sidebarStorageText");
        const topbarDiskText = document.getElementById("topbarDiskUsage");
        const used = stats.disk.used_formatted || "N/A";
        const total = stats.disk.total_formatted || "N/A";

        if (fill) fill.style.width = `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%`;
        if (text) text.textContent = `${used} / ${total}${percent === null ? "" : ` (${percent}%)`}`;
        if (topbarDiskText) topbarDiskText.textContent = `${used} / ${total}`;
      }

      if (modal && modal.classList.contains("show")) {
        this.renderSystemStatsModal(stats);
      }
      if (showToast) {
        UI.toast(t("stats_updated_toast"), "success", 1200);
      }
    } catch (err) {
      if (showToast) {
        UI.toast(t("stats_error_toast", { msg: err.message }), "error");
      }
      if (!AppState.systemStats && body && modal && modal.classList.contains("show")) {
        body.innerHTML = `
          <div class="flex flex-col items-center justify-center py-10 text-slate-500 gap-3 text-center">
            <i class="fa-solid fa-triangle-exclamation text-2xl text-amber-500"></i>
            <p class="text-sm">${UI.escape(t("stats_error_toast", { msg: err.message }))}</p>
            <button class="btn-secondary text-xs py-2 px-4" onclick="App.refreshSystemStats(false)">${t("stats_refresh_btn")}</button>
          </div>
        `;
      }
    } finally {
      if (btn && showToast && originalIcon) {
        btn.innerHTML = originalIcon;
        btn.disabled = false;
      }
    }
  },

  async openSystemModal() {
    this.toggleMobileSidebar(false);
    UI.openModal("systemStatsModal");

    const container = document.getElementById("systemStatsBody");
    if (AppState.systemStats) {
      this.renderSystemStatsModal(AppState.systemStats);
      this.refreshSystemStats(false);
    } else {
      if (container) {
        container.innerHTML = `
          <div class="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
            <i class="fa-solid fa-circle-notch fa-spin text-3xl text-brand-600"></i>
            <span class="text-sm font-medium text-slate-600">${t("stats_scanning")}</span>
          </div>
        `;
      }
      await this.refreshSystemStats(false);
    }
  },

  async openPortsPage() {
    this.directoryLoadSequence += 1;
    this.toggleMobileSidebar(false);
    const mainContent = document.getElementById("mainContentArea");
    const portsPage = document.getElementById("portManagerPage");
    if (mainContent) mainContent.classList.add("hidden");
    if (portsPage) {
      portsPage.classList.remove("hidden");
      portsPage.style.display = "flex";
    }
    this.setActiveNavigation("navPorts");
    await this.refreshPortsPage(false);
  },

  async refreshPortsPage(showToast = false) {
    const body = document.getElementById("portsPageBody");
    const button = document.getElementById("btnRefreshPorts");
    let originalButton = null;
    if (button && showToast) {
      originalButton = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> ' + t("port_manager_refresh");
    }
    if (body && !AppState.ports.length && !AppState.portsError) {
      body.innerHTML = '<div class="flex items-center gap-2 text-sm text-slate-500 py-6"><i class="fa-solid fa-circle-notch fa-spin text-brand-600"></i><span>' + t("port_scan_loading") + '</span></div>';
    }

    try {
      const result = await API.getListeningPorts();
      AppState.ports = result.ports || [];
      AppState.portsError = "";
      this.renderPortsPage();
      if (showToast) UI.toast(t("port_scan_success"), "success");
    } catch (error) {
      AppState.ports = [];
      AppState.portsError = error.message || String(error);
      this.renderPortsPage();
    } finally {
      if (button && originalButton) {
        button.innerHTML = originalButton;
        button.disabled = false;
      }
    }
  },

  renderPortsPage() {
    const body = document.getElementById("portsPageBody");
    if (!body) return;

    if (AppState.portsError) {
      body.innerHTML = '<div class="text-sm text-rose-700 p-4 rounded-xl bg-rose-50 border border-rose-100">' +
        t("port_manager_error", { msg: UI.escape(AppState.portsError) }) +
        '<div><button class="btn-secondary text-xs py-2 px-3 mt-3" onclick="App.refreshPortsPage(false)">' + t("port_scan_retry") + '</button></div>' +
      '</div>';
      return;
    }

    if (!AppState.ports.length) {
      body.innerHTML = '<div class="text-sm text-slate-500 p-4 rounded-xl bg-white border border-slate-200">' + t("port_manager_empty") + '</div>';
      return;
    }

    const portCards = AppState.ports.map(port => {
      const tunnelActive = Boolean(port.tunnel && port.tunnel.active);
      const portDetails = [port.process || t("port_process_unknown"), port.address]
        .filter(Boolean)
        .map(value => UI.escape(value))
        .join(" / ");
      const tunnelUrl = tunnelActive && port.tunnel.url
        ? '<a class="text-xs text-sky-700 hover:text-sky-900 underline break-all" target="_blank" rel="noopener noreferrer" href="' + UI.escape(port.tunnel.url) + '">' + UI.escape(port.tunnel.url) + '</a>'
        : "";
      return '<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-slate-200 bg-white shadow-sm">' +
        '<div class="min-w-0">' +
          '<div class="flex items-center gap-2"><span class="font-mono text-base font-bold text-slate-800">:' + Number(port.port) + '</span>' +
            '<span class="text-[10px] px-2 py-0.5 rounded-full ' + (tunnelActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500') + '">' +
              t(tunnelActive ? "port_tunnel_active" : "port_tunnel_inactive") + '</span></div>' +
          '<div class="text-xs text-slate-500 mt-1 truncate">' + portDetails + '</div>' +
          (tunnelUrl ? '<div class="mt-2">' + tunnelUrl + '</div>' : "") +
        '</div>' +
        '<div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto shrink-0">' +
          '<button type="button" data-tunnel-port="' + Number(port.port) + '" onclick="App.togglePortTunnel(' + Number(port.port) + ')" class="' +
            (tunnelActive ? 'btn-secondary' : 'btn-primary') + ' w-full sm:w-auto text-xs py-2 px-3">' +
            '<i class="fa-brands fa-cloudflare mr-1"></i> ' + t(tunnelActive ? "port_tunnel_close" : "port_tunnel_open") +
          '</button>' +
          '<button type="button" data-local-port="' + Number(port.port) + '" onclick="App.closeLocalPort(' + Number(port.port) + ')" class="btn-danger w-full sm:w-auto text-xs py-2 px-3">' +
            '<i class="fa-solid fa-power-off mr-1"></i> ' + t("port_local_close") +
          '</button>' +
        '</div>' +
      '</div>';
    }).join("");
    body.innerHTML = '<div class="space-y-2">' + portCards + '</div>';
  },

  confirmApplicationTunnelClose(port) {
    return UI.confirm({
      title: t("port_application_tunnel_title"),
      message: t("port_application_tunnel_confirm", { port }),
      confirmText: t("port_tunnel_close"),
      confirmIcon: "fa-cloud-arrow-down"
    });
  },

  confirmLocalPortClose(port, processName, isApplication) {
    const key = isApplication ? "port_application_local_close_confirm" : "port_local_close_confirm";
    return UI.confirm({
      title: t("port_local_close_title"),
      message: t(key, { port, process: processName }),
      confirmText: t("port_local_close"),
      confirmIcon: "fa-power-off"
    });
  },

  async togglePortTunnel(portValue) {
    const port = Number(portValue);
    const item = AppState.ports.find(entry => Number(entry.port) === port);
    if (!Number.isInteger(port) || !item) return;

    const isClosing = Boolean(item.tunnel && item.tunnel.active);
    if (isClosing && (item.is_application || port === 8000) &&
        !(await this.confirmApplicationTunnelClose(port))) {
      return;
    }

    const buttons = Array.from(document.querySelectorAll("[data-tunnel-port]"))
      .filter(button => Number(button.dataset.tunnelPort) === port);
    const originalButtonHtml = new Map(buttons.map(button => [button, button.innerHTML]));
    const pendingLabel = t(isClosing ? "port_tunnel_closing" : "port_tunnel_opening");
    buttons.forEach(button => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1" aria-hidden="true"></i> ' +
        UI.escape(pendingLabel);
    });

    try {
      if (isClosing) {
        await API.stopPortTunnel(port);
        UI.toast(t("port_tunnel_stopped", { port }), "success");
      } else {
        await API.startPortTunnel(port);
        UI.toast(t("port_tunnel_started", { port }), "success");
      }
      await this.refreshPortsPage(false);
    } catch (error) {
      UI.toast(error.message || t("port_tunnel_error"), "error");
      buttons.forEach(button => {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.innerHTML = originalButtonHtml.get(button) || "";
      });
    }
  },


  async closeLocalPort(portValue) {
    const port = Number(portValue);
    const item = AppState.ports.find(entry => Number(entry.port) === port);
    if (!Number.isInteger(port) || !item) return;

    const processName = item.process || t("port_process_unknown");
    if (!(await this.confirmLocalPortClose(port, processName, Boolean(item.is_application)))) return;

    const buttons = Array.from(document.querySelectorAll("[data-local-port]"))
      .filter(button => Number(button.dataset.localPort) === port);
    const originalButtonHtml = new Map(buttons.map(button => [button, button.innerHTML]));
    buttons.forEach(button => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1" aria-hidden="true"></i> ' +
        UI.escape(t("port_local_closing"));
    });

    try {
      await API.closeLocalPort(port);
      UI.toast(t("port_local_closed", { port }), "success");
      if (!item.is_application) await this.refreshPortsPage(false);
    } catch (error) {
      UI.toast(error.message || t("port_local_close_error"), "error");
      buttons.forEach(button => {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.innerHTML = originalButtonHtml.get(button) || "";
      });
    }
  },

  renderSystemStatsModal(stats) {
    const container = document.getElementById("systemStatsBody");
    if (!container || !stats) return;

    const getBadgeClass = (percent) => {
      if (percent === null) return "bg-slate-50 text-slate-500 border-slate-200";
      if (percent >= 85) return "bg-rose-50 text-rose-700 border-rose-200";
      if (percent >= 70) return "bg-amber-50 text-amber-700 border-amber-200";
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    };

    const getBarColor = (percent, defaultGradient) => {
      if (percent === null) return "bg-slate-300";
      if (percent >= 85) return "bg-gradient-to-r from-rose-500 to-red-600";
      if (percent >= 70) return "bg-gradient-to-r from-amber-400 to-amber-600";
      return defaultGradient;
    };

    const getPercent = (metric) => {
      if (!metric || metric.status === "unavailable" || !Number.isFinite(metric.percent)) return null;
      return Math.min(100, Math.max(0, metric.percent));
    };

    const disk = stats.disk || {};
    const diskP = getPercent(disk);
    const mem = stats.memory || {};
    const memP = getPercent(mem);
    const cpu = stats.cpu || {};
    const cpuP = getPercent(cpu);
    // GPU Cards: keep VRAM values separate because devices do not share memory.
    const gpu = stats.gpu || { status: "query_error" };
    let gpuCardHtml = "";
    if (gpu.status === "available" && Array.isArray(gpu.devices) && gpu.devices.length > 0) {
      gpuCardHtml = gpu.devices.map((device, index) => {
        const vramP = device.vram_percent || 0;
        const gpuTitle = gpu.devices.length > 1 ? `${t("stats_gpu_card")} ${index + 1}` : t("stats_gpu_card");
        return `
          <div class="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-4 rounded-2xl border border-slate-700/80 shadow-md relative overflow-hidden flex flex-col justify-between">
            <div class="absolute -right-3 -bottom-3 opacity-10 text-6xl text-emerald-400 pointer-events-none"><i class="fa-solid fa-microchip"></i></div>
            <div>
              <div class="flex items-center justify-between mb-2.5">
                <div class="flex items-center gap-2.5 min-w-0">
                  <span class="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-sm shrink-0 shadow-inner"><i class="fa-solid fa-microchip"></i></span>
                  <div class="min-w-0">
                    <div class="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">${gpuTitle}</div>
                    <div class="text-sm font-bold text-white truncate" title="${UI.escape(device.name)}">${UI.escape(device.name)}</div>
                  </div>
                </div>
                <span class="text-xs font-mono px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-bold shrink-0">${t("stats_gpu_util", { percent: device.utilization_percent })}</span>
              </div>
              <div class="mt-3">
                <div class="flex justify-between text-xs text-slate-300 mb-1 font-medium">
                  <span>${t("stats_vram_used")}</span>
                  <span class="text-white font-semibold font-mono">${device.vram_used} / ${device.vram_total}</span>
                </div>
                <div class="h-2 w-full bg-slate-700/80 rounded-full overflow-hidden p-0.5"><div class="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-400 transition-all duration-500" style="width: ${Math.min(100, vramP)}%"></div></div>
              </div>
            </div>
            <div class="flex justify-between items-center text-[11px] text-slate-400 mt-2 font-mono pt-1 border-t border-slate-700/40">
              <span>${t("stats_vram_free", { free: device.vram_free })}</span>
              <span class="text-emerald-400 font-semibold">${t("stats_vram_percent", { percent: vramP })}</span>
            </div>
          </div>
        `;
      }).join("");
    } else {
      const gpuNotFound = gpu.status === "not_found";
      const titleKey = gpuNotFound ? "stats_gpu_none_title" : "stats_gpu_error_title";
      const descriptionKey = gpuNotFound ? "stats_gpu_none_desc" : "stats_gpu_error_desc";
      const badgeKey = gpuNotFound ? "stats_gpu_none_badge" : "stats_gpu_error_badge";
      gpuCardHtml = `
        <div class="bg-white p-4 rounded-2xl border border-slate-200/90 shadow-sm flex flex-col justify-between">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-8 h-8 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center text-sm shrink-0"><i class="fa-solid fa-microchip"></i></span>
              <div>
                <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">${t("stats_gpu_card")}</div>
                <div class="text-sm font-bold text-slate-700">${t(titleKey)}</div>
              </div>
            </div>
            <span class="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 font-medium font-sans leading-none shrink-0 whitespace-nowrap">${t(badgeKey)}</span>
          </div>
          <p class="text-xs text-slate-500 mt-2 leading-relaxed">${t(descriptionKey)}</p>
          <div class="text-[11px] text-slate-400 font-mono mt-2 pt-1 border-t border-slate-100">GPU: ${t(badgeKey)}</div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div class="bg-white p-4 rounded-2xl border border-slate-200/90 shadow-sm flex flex-col justify-between">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-sm shrink-0"><i class="fa-solid fa-hard-drive"></i></span>
                <div class="min-w-0">
                  <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">${t("stats_disk_card")}</div>
                  <div class="text-sm font-bold text-slate-800 truncate">${disk.used_formatted || "N/A"} / ${disk.total_formatted || "N/A"}</div>
                </div>
              </div>
              <span class="text-xs font-mono px-2 py-0.5 rounded-full border ${getBadgeClass(diskP)} font-bold shrink-0">${diskP === null ? "N/A" : `${diskP}%`}</span>
            </div>
            <div class="mt-2">
              <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden"><div class="h-full ${getBarColor(diskP, "bg-gradient-to-r from-blue-500 to-indigo-600")} transition-all duration-500" style="width: ${diskP === null ? 0 : diskP}%"></div></div>
              <div class="flex justify-between items-center text-[11px] text-slate-500 mt-2 font-mono">
                <span>${t("stats_free")}: <b>${disk.free_formatted || "N/A"}</b></span>
                <span class="text-slate-400 truncate" title="${UI.escape(stats.root_dir || "/")}">${UI.escape(stats.root_dir || "/")}</span>
              </div>
            </div>
          </div>

          <div class="bg-white p-4 rounded-2xl border border-slate-200/90 shadow-sm flex flex-col justify-between">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-sm shrink-0"><i class="fa-solid fa-memory"></i></span>
                <div class="min-w-0">
                  <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">${t("stats_ram_card")}</div>
                  <div class="text-sm font-bold text-slate-800 truncate">${mem.used_formatted || "N/A"} / ${mem.total_formatted || "N/A"}</div>
                </div>
              </div>
              <span class="text-xs font-mono px-2 py-0.5 rounded-full border ${getBadgeClass(memP)} font-bold shrink-0">${memP === null ? "N/A" : `${memP}%`}</span>
            </div>
            <div class="mt-2">
              <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden"><div class="h-full ${getBarColor(memP, "bg-gradient-to-r from-emerald-500 to-teal-600")} transition-all duration-500" style="width: ${memP === null ? 0 : memP}%"></div></div>
              <div class="flex justify-between items-center text-[11px] text-slate-500 mt-2 font-mono"><span>${t("stats_available")}: <b>${mem.free_formatted || "N/A"}</b></span><span class="text-slate-400">System RAM</span></div>
            </div>
          </div>

          <div class="bg-white p-4 rounded-2xl border border-slate-200/90 shadow-sm flex flex-col justify-between">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-8 h-8 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center text-sm shrink-0"><i class="fa-solid fa-microchip"></i></span>
                <div class="min-w-0">
                  <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">${t("stats_cpu_card")}</div>
                  <div class="text-sm font-bold text-slate-800 truncate">${t("stats_cpu_cores", { cores: cpu.cores || 1 })}</div>
                </div>
              </div>
              <span class="text-xs font-mono px-2 py-0.5 rounded-full border ${getBadgeClass(cpuP)} font-bold shrink-0">${cpuP === null ? "N/A" : `${cpuP}%`}</span>
            </div>
            <div class="mt-2">
              <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden"><div class="h-full ${getBarColor(cpuP, "bg-gradient-to-r from-purple-500 to-indigo-600")} transition-all duration-500" style="width: ${cpuP === null ? 0 : cpuP}%"></div></div>
              <div class="flex justify-between items-center text-[11px] text-slate-500 mt-2 font-mono"><span>${cpuP === null ? "N/A" : t("stats_cpu_load", { percent: cpuP })}</span><span class="text-slate-400">${t("stats_cpu_instant")}</span></div>
            </div>
          </div>

          ${gpuCardHtml}
        </div>
        <div class="pt-3 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-2.5 text-xs">
          <div class="flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-slate-100 text-slate-700 font-semibold text-[11px]"><i class="fa-brands fa-linux text-slate-500"></i> ${UI.escape(stats.os || "Linux")}</span>
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-50 text-amber-800 border border-amber-200/80 font-semibold text-[11px]"><i class="fa-brands fa-python text-amber-600"></i> Python ${UI.escape(stats.python || "3.13")}</span>
          </div>
          <span class="text-[11px] text-slate-400 font-mono flex items-center gap-1"><i class="fa-solid fa-folder-tree text-slate-400"></i> ${UI.escape(stats.root_dir || "/kaggle/working")}</span>
        </div>
      </div>
    `;
  },


  terminalTabs: [],
  activeTerminalTabId: null,
  terminalStorageKey: "kaggle_drive_terminal_tabs_v1",
  terminalInstance: null,
  terminalFitAddon: null,
  terminalSocket: null,
  terminalResizeObserver: null,
  terminalPendingInput: [],
  terminalRequestedCwd: null,

  newTerminalSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },

  persistTerminalTabs() {
    try {
      sessionStorage.setItem(this.terminalStorageKey, JSON.stringify({
        activeId: this.activeTerminalTabId,
        wasOpen: Boolean(document.getElementById("terminalModal")?.classList.contains("show")),
        tabs: this.terminalTabs.map(tab => ({
          id: tab.id,
          title: tab.title,
          cwd: tab.cwd,
          sessionId: tab.sessionId
        }))
      }));
    } catch (_) {}
  },

  restoreTerminalSessions() {
    if (this.terminalTabs.length) return;
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(this.terminalStorageKey) || "null");
    } catch (_) {
      return;
    }
    if (!saved || !Array.isArray(saved.tabs)) return;
    const wasOpen = Boolean(saved.wasOpen);

    const usedSessionIds = new Set();
    const usedTabIds = new Set();
    const restored = [];
    for (const record of saved.tabs.slice(0, 4)) {
      if (
        !record ||
        !/^terminal-[1-4]$/.test(record.id || "") ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.sessionId || "") ||
        usedTabIds.has(record.id) ||
        usedSessionIds.has(record.sessionId)
      ) continue;
      usedTabIds.add(record.id);
      usedSessionIds.add(record.sessionId);
      const tab = this.createTerminalTab(String(record.cwd || ""), {
        id: record.id,
        title: String(record.title || record.id),
        sessionId: record.sessionId,
        restored: true
      });
      if (tab) restored.push(tab);
    }
    if (!restored.length) return;

    const activeTab = restored.find(tab => tab.id === saved.activeId) || restored[0];
    this.activateTerminalTab(activeTab.id);
    if (wasOpen) {
      this.setTerminalMinimized(false);
      UI.openModal("terminalModal");
    } else {
      this.setTerminalMinimized(true);
    }
    this.persistTerminalTabs();
    restored.forEach(tab => this.connectTerminal(tab));
  },

  getActiveTerminalTab() {
    return this.terminalTabs.find(tab => tab.id === this.activeTerminalTabId) || null;
  },

  terminalPath(cwd) {
    const suffix = (cwd || "").replace(/^\/+|\/+$/g, "");
    const configuredRoot = String(AppState.rootDir || "/kaggle/working");
    const root = configuredRoot.replace(/[\\/]+$/, "") ||
      (configuredRoot.startsWith("\\") ? "\\" : "/");
    const separator = root.endsWith("/") || root.endsWith("\\")
      ? ""
      : (root.includes("\\") && !root.includes("/") ? "\\" : "/");
    return suffix ? root + separator + suffix : root;
  },

  renderTerminalTabs() {
    const list = document.getElementById("terminalTabs");
    if (list) {
      list.replaceChildren();
      const statuses = {
        connected: t("terminal_status_connected"),
        connecting: t("terminal_status_connecting"),
        reconnecting: t("terminal_status_reconnecting"),
        disconnected: t("terminal_status_disconnected"),
        error: t("terminal_status_error")
      };
      this.terminalTabs.forEach(tab => {
        const isActive = tab.id === this.activeTerminalTabId;
        const item = document.createElement("div");
        item.className = "terminal-tab" + (isActive ? " is-active" : "");

        const select = document.createElement("button");
        select.type = "button";
        select.className = "terminal-tab-select";
        select.setAttribute("role", "tab");
        select.setAttribute("aria-selected", String(isActive));
        select.setAttribute("aria-controls", "terminal-panel-" + tab.id);
        select.title = tab.title + " — " + this.terminalPath(tab.cwd);
        select.addEventListener("click", () => this.activateTerminalTab(tab.id));

        const status = document.createElement("span");
        status.className = "terminal-tab-status is-" + (tab.status || "connecting");
        status.title = statuses[tab.status] || statuses.connecting;
        status.setAttribute("aria-label", status.title);

        const label = document.createElement("span");
        label.className = "terminal-tab-label";
        label.textContent = tab.title;
        select.append(status, label);

        const close = document.createElement("button");
        close.type = "button";
        close.className = "terminal-tab-close";
        close.title = t("terminal_close_tab", { name: tab.title });
        close.setAttribute("aria-label", close.title);
        close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        close.addEventListener("click", () => this.closeTerminalTab(tab.id));

        item.append(select, close);
        list.appendChild(item);
      });
    }

    const hasTabs = this.terminalTabs.length > 0;
    const emptyState = document.getElementById("terminalEmptyState");
    const terminalWindow = document.getElementById("terminalWindow");
    if (emptyState) emptyState.classList.toggle("hidden", hasTabs);
    if (terminalWindow) terminalWindow.classList.toggle("hidden", !hasTabs);
  },

  createTerminalTab(cwd = "", options = {}) {
    if (this.terminalTabs.length >= 4) {
      UI.toast(t("terminal_max_tabs"), "warning");
      return null;
    }

    const usedNumbers = new Set(this.terminalTabs.map(tab => Number(tab.id.split("-").pop())));
    let number = 1;
    while (usedNumbers.has(number)) number += 1;
    const tab = {
      id: options.id || "terminal-" + number,
      title: options.title || "Terminal " + number,
      cwd: cwd || "",
      sessionId: options.sessionId || this.newTerminalSessionId(),
      restoredFromStorage: Boolean(options.restored),
      needsReplay: Boolean(options.restored),
      connectedOnce: Boolean(options.restored),
      status: "connecting",
      instance: null,
      fitAddon: null,
      socket: null,
      resizeObserver: null,
      pendingInput: [],
      heartbeatTimer: null,
      serverSentTerminalError: false,
      serverTerminalErrorMessage: "",
      reconnectTimer: null,
      stableTimer: null,
      reconnectAttempts: 0,
      reconnectFailureLogged: false,
      container: null
    };
    this.terminalTabs.push(tab);
    this.initTerminalEmulator(tab);
    this.renderTerminalTabs();
    this.activateTerminalTab(tab.id);
    this.persistTerminalTabs();
    return tab;
  },

  openTerminalModal(targetCwd = null) {
    this.hideContextMenu();
    this.toggleMobileSidebar(false);

    const cwd = targetCwd !== null ? targetCwd : (AppState.currentPath || "");
    let tab = targetCwd !== null ? this.createTerminalTab(cwd) : this.getActiveTerminalTab();
    if (!tab) tab = this.createTerminalTab(cwd);
    if (!tab) return;

    this.setTerminalMinimized(false);
    UI.openModal("terminalModal");
    this.persistTerminalTabs();
    this.activateTerminalTab(tab.id);
    setTimeout(() => {
      if (this.activeTerminalTabId !== tab.id) return;
      this.fitTerminal(tab);
      if (tab.instance) tab.instance.focus();
      if (tab.instance && (!tab.socket || tab.socket.readyState > WebSocket.OPEN)) {
        this.connectTerminal(tab);
      }
    }, 120);
    return tab;
  },

  openNewTerminalTab() {
    this.hideContextMenu();
    this.toggleMobileSidebar(false);
    this.setTerminalMinimized(false);
    UI.openModal("terminalModal");
    this.persistTerminalTabs();
    const tab = this.createTerminalTab(AppState.currentPath || "");
    if (!tab) return;
    setTimeout(() => {
      if (this.activeTerminalTabId !== tab.id) return;
      this.fitTerminal(tab);
      if (tab.instance) tab.instance.focus();
      if (tab.instance) this.connectTerminal(tab);
    }, 120);
  },

  activateTerminalTab(tabId) {
    const tab = this.terminalTabs.find(item => item.id === tabId);
    if (!tab) return;
    this.activeTerminalTabId = tab.id;
    this.terminalTabs.forEach(item => {
      if (item.container) item.container.hidden = item.id !== tab.id;
    });

    this.terminalInstance = tab.instance;
    this.terminalFitAddon = tab.fitAddon;
    this.terminalSocket = tab.socket;
    this.terminalResizeObserver = tab.resizeObserver;
    this.terminalPendingInput = tab.pendingInput;
    this.terminalRequestedCwd = tab.cwd;
    AppState.terminalCwd = tab.cwd;
    this.persistTerminalTabs();

    const header = document.getElementById("terminalHeaderTitle");
    if (header) header.textContent = tab.title + " — bash";
    this.renderTerminalTabs();

    requestAnimationFrame(() => {
      if (this.activeTerminalTabId !== tab.id) return;
      this.fitTerminal(tab);
      const terminalModal = document.getElementById("terminalModal");
      if (tab.instance && terminalModal?.classList.contains("show")) tab.instance.focus();
    });
  },

  initTerminalEmulator(tab) {
    const parent = document.getElementById("terminalWindow");
    if (!parent) return false;
    const container = document.createElement("div");
    container.id = "terminal-panel-" + tab.id;
    container.className = "terminal-tab-panel";
    container.hidden = true;
    parent.appendChild(container);
    tab.container = container;

    const TerminalCtor = window.Terminal?.Terminal || window.Terminal;
    const FitAddonCtor = window.FitAddon?.FitAddon;
    if (!TerminalCtor || !FitAddonCtor) {
      container.textContent = "Terminal emulator assets could not be loaded. Check the notebook internet connection and reload the page.";
      tab.status = "error";
      return false;
    }

    tab.instance = new TerminalCtor({
      cursorBlink: true,
      convertEol: false,
      scrollback: 3000,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#020617",
        foreground: "#e2e8f0",
        cursor: "#38bdf8",
        selectionBackground: "#334155"
      }
    });
    tab.fitAddon = new FitAddonCtor();
    tab.instance.loadAddon(tab.fitAddon);
    tab.instance.open(container);
    this.setupTerminalClipboard(tab, container);
    tab.instance.onData(data => this.sendTerminalInput(data, tab));
    tab.resizeObserver = new ResizeObserver(() => this.fitTerminal(tab));
    tab.resizeObserver.observe(container);
    return true;
  },

  async copyTextToClipboard(text) {
    if (!text) return false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    try {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      helper.style.pointerEvents = "none";
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand("copy");
      helper.remove();
      return Boolean(copied);
    } catch (_) {
      return false;
    }
  },

  pasteTextToTerminal(tab, text) {
    if (!tab || !tab.instance || !text) return;
    if (typeof tab.instance.paste === "function") {
      tab.instance.paste(text);
    } else {
      this.sendTerminalInput(text, tab);
    }
  },

  getTerminalLogicalLineRange(buffer, cursorRow) {
    let startRow = cursorRow;
    while (startRow > 0) {
      const line = buffer.getLine(startRow);
      if (!line || !line.isWrapped) break;
      startRow -= 1;
    }
    let endRow = cursorRow;
    while (endRow + 1 < buffer.length) {
      const nextLine = buffer.getLine(endRow + 1);
      if (!nextLine || !nextLine.isWrapped) break;
      endRow += 1;
    }
    return { startRow, endRow };
  },

  countTerminalChars(buffer, startRow, targetRow, targetCol) {
    let count = 0;
    let cell = buffer.getNullCell ? buffer.getNullCell() : null;
    for (let row = startRow; row <= targetRow; row += 1) {
      const line = buffer.getLine(row);
      if (!line) break;
      const limitCol = row === targetRow ? Math.min(targetCol, line.length) : line.length;
      for (let col = 0; col < limitCol; col += 1) {
        cell = line.getCell(col, cell);
        if (!cell) continue;
        if (cell.getWidth() > 0) {
          count += 1;
        }
      }
    }
    return count;
  },

  getTerminalLineEndOffset(buffer, startRow, endRow, cursorOffset) {
    let lastNonEmpty = 0;
    let total = 0;
    let cell = buffer.getNullCell ? buffer.getNullCell() : null;
    for (let row = startRow; row <= endRow; row += 1) {
      const line = buffer.getLine(row);
      if (!line) break;
      for (let col = 0; col < line.length; col += 1) {
        cell = line.getCell(col, cell);
        if (!cell) continue;
        if (cell.getWidth() > 0) {
          total += 1;
          const ch = cell.getChars();
          if (ch && ch !== " ") {
            lastNonEmpty = total;
          }
        }
      }
    }
    return Math.max(lastNonEmpty, cursorOffset);
  },

  deleteTerminalSelection(tab) {
    if (!tab || !tab.instance || !tab.instance.hasSelection()) return false;
    if (typeof tab.instance.getSelectionPosition !== "function") return false;

    const buffer = tab.instance.buffer && tab.instance.buffer.active;
    if (!buffer || buffer.type === "alternate") return false;

    const pos = tab.instance.getSelectionPosition();
    if (!pos || !pos.start || !pos.end) return false;

    let start = pos.start;
    let end = pos.end;
    if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
      [start, end] = [end, start];
    }

    const cursorRow = buffer.baseY + buffer.cursorY;
    const { startRow, endRow } = this.getTerminalLogicalLineRange(buffer, cursorRow);
    if (start.y < startRow || end.y > endRow) {
      return false;
    }

    const cursorOffset = this.countTerminalChars(buffer, startRow, cursorRow, buffer.cursorX);
    const lineEndOffset = this.getTerminalLineEndOffset(buffer, startRow, endRow, cursorOffset);
    const selStartOffset = this.countTerminalChars(buffer, startRow, start.y, start.x);
    const selEndOffset = Math.min(
      this.countTerminalChars(buffer, startRow, end.y, end.x),
      lineEndOffset
    );

    const deleteCount = selEndOffset - selStartOffset;
    if (deleteCount <= 0) {
      tab.instance.clearSelection();
      return false;
    }

    const moveDelta = selEndOffset - cursorOffset;
    let sequence = "";
    if (moveDelta < 0) {
      sequence += "\x1b[D".repeat(-moveDelta);
    } else if (moveDelta > 0) {
      sequence += "\x1b[C".repeat(moveDelta);
    }
    sequence += "\x7f".repeat(deleteCount);

    tab.instance.clearSelection();
    this.sendTerminalInput(sequence, tab);
    return true;
  },

  setupTerminalClipboard(tab, container) {
    if (!tab || !tab.instance) return;
    let nativePasteFired = false;
    if (container) {
      container.addEventListener("paste", () => {
        nativePasteFired = true;
      }, true);
    }

    tab.instance.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const isModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = (event.key || "").toLowerCase();

      if (isModifier) {
        if (key === "c") {
          if (tab.instance.hasSelection()) {
            const selectedText = tab.instance.getSelection();
            event.preventDefault();
            tab.instance.clearSelection();
            this.copyTextToClipboard(selectedText).then((ok) => {
              if (!ok) UI.toast(t("terminal_copy_failed"), "warning");
            });
            return false;
          }
          if (event.shiftKey) {
            event.preventDefault();
            return false;
          }
          // No selection: pass Ctrl+C through as SIGINT (\x03).
          return true;
        }

        if (key === "v") {
          if (tab.instance.hasSelection()) {
            this.deleteTerminalSelection(tab);
          }
          nativePasteFired = false;
          // Let the browser's native paste event trigger xterm's paste handler
          // without sending Ctrl+V (\x16) to the PTY; fall back to Clipboard API
          // only when native paste did not fire (e.g. Ctrl+Shift+V in some browsers).
          window.setTimeout(() => {
            if (nativePasteFired) return;
            if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
              navigator.clipboard.readText()
                .then((text) => this.pasteTextToTerminal(tab, text))
                .catch(() => {});
            }
          }, 20);
          return false;
        }

        return true;
      }

      if (!event.altKey && tab.instance.hasSelection()) {
        if (event.key === "Backspace" || event.key === "Delete") {
          if (this.deleteTerminalSelection(tab)) {
            event.preventDefault();
            return false;
          }
          return true;
        }

        if (
          !event.isComposing &&
          event.key !== "Process" &&
          event.keyCode !== 229 &&
          event.key &&
          event.key.length === 1
        ) {
          this.deleteTerminalSelection(tab);
          return true;
        }
      }

      return true;
    });
  },

  connectTerminal(tab = this.getActiveTerminalTab()) {
    if (!tab || !tab.instance) return;
    if (tab.reconnectTimer !== null) {
      window.clearTimeout(tab.reconnectTimer);
      tab.reconnectTimer = null;
    }
    if (tab.socket && tab.socket.readyState <= WebSocket.OPEN) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wasReconnectingSession = Boolean(
      tab.restoredFromStorage || tab.connectedOnce || tab.needsReplay
    );
    const terminalParams = new URLSearchParams({
      cwd: tab.cwd || "",
      session_id: tab.sessionId
    });
    if (tab.needsReplay || tab.connectedOnce) {
      terminalParams.set("replay", "1");
      tab.instance.clear();
    }
    const url = protocol + "//" + window.location.host + "/api/system/terminal/ws?" + terminalParams.toString();
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    tab.serverSentTerminalError = false;
    tab.serverTerminalErrorMessage = "";
    tab.socket = socket;
    if (this.activeTerminalTabId === tab.id) this.terminalSocket = socket;
    tab.status = "connecting";
    this.renderTerminalTabs();

    socket.onopen = () => {
      if (tab.socket !== socket) return;
      tab.status = "connected";
      if (tab.stableTimer !== null) window.clearTimeout(tab.stableTimer);
      tab.stableTimer = window.setTimeout(() => {
        if (tab.socket === socket) {
          tab.reconnectAttempts = 0;
          tab.reconnectFailureLogged = false;
        }
        tab.stableTimer = null;
      }, 10000);
      this.renderTerminalTabs();
      this.fitTerminal(tab);
      const terminalModal = document.getElementById("terminalModal");
      if (this.activeTerminalTabId === tab.id && terminalModal?.classList.contains("show")) {
        tab.instance.focus();
      }
      for (const data of tab.pendingInput.splice(0)) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
      tab.heartbeatTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ type: "ping" })); } catch (_) {}
        }
      }, 20000);
    };
    socket.onmessage = event => {
      if (!tab.instance) return;
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "pong") return;
          if (message.type === "session") {
            tab.sessionId = message.session_id || tab.sessionId;
            if (wasReconnectingSession && !message.resumed) {
              tab.instance.writeln("\r\n\x1b[33mThe previous terminal session is no longer available; a new shell was started.\x1b[0m");
            }
            tab.connectedOnce = true;
            tab.needsReplay = false;
            tab.restoredFromStorage = false;
            this.persistTerminalTabs();
            return;
          }
          if (message.type === "history_truncated") {
            tab.instance.writeln("\x1b[33mEarlier terminal output was truncated while disconnected.\x1b[0m");
            return;
          }
          if (message.type === "exit") {
            tab.status = "disconnected";
            this.renderTerminalTabs();
            return;
          }
          if (message.type === "error") {
            tab.serverSentTerminalError = true;
            tab.serverTerminalErrorMessage = message.message || "Terminal error";
            tab.status = tab.reconnectAttempts > 0 ? "reconnecting" : "error";
            this.renderTerminalTabs();
            return;
          }
        } catch (_) {}
        tab.instance.write(event.data);
      } else {
        tab.instance.write(new Uint8Array(event.data));
      }
    };
    socket.onerror = () => {
      // Browsers hide handshake and network details; onclose provides the close code.
    };
    socket.onclose = event => {
      if (tab.heartbeatTimer !== null) {
        window.clearInterval(tab.heartbeatTimer);
        tab.heartbeatTimer = null;
      }
      if (tab.stableTimer !== null) {
        window.clearTimeout(tab.stableTimer);
        tab.stableTimer = null;
      }
      const wasCurrentSocket = tab.socket === socket;
      if (wasCurrentSocket) {
        tab.socket = null;
        if (tab.connectedOnce || tab.restoredFromStorage) tab.needsReplay = true;
        tab.status = tab.serverSentTerminalError && event.code !== 1013 ? "error" : "disconnected";
        if (this.activeTerminalTabId === tab.id) this.terminalSocket = null;
        this.renderTerminalTabs();
      }
      if (!wasCurrentSocket || event.code === 1000 || !tab.instance) return;

      const shouldRetry = event.code !== 1008 &&
        (!tab.serverSentTerminalError || event.code === 1013);
      if (!shouldRetry) {
        const errorMessage = tab.serverSentTerminalError
          ? (tab.serverTerminalErrorMessage || "Terminal error")
          : "Terminal session rejected. Please sign in again.";
        tab.instance.writeln("\r\n\x1b[31m" + errorMessage + "\x1b[0m");
      } else if (tab.reconnectAttempts >= 5 && !tab.reconnectFailureLogged) {
        tab.instance.writeln("\r\n\x1b[33m" + t("terminal_reconnect_warning") + "\x1b[0m");
        tab.reconnectFailureLogged = true;
      }
      if (shouldRetry) this.scheduleTerminalReconnect(tab);
    };
  },


  scheduleTerminalReconnect(tab) {
    if (!this.terminalTabs.includes(tab) || !tab.instance || tab.socket) return;
    if (tab.reconnectTimer !== null) window.clearTimeout(tab.reconnectTimer);

    const delay = Math.min(1000 * Math.pow(2, tab.reconnectAttempts), 30000);
    tab.reconnectAttempts += 1;
    tab.status = "reconnecting";
    this.renderTerminalTabs();
    tab.reconnectTimer = window.setTimeout(() => {
      tab.reconnectTimer = null;
      if (this.terminalTabs.includes(tab) && !tab.socket) this.connectTerminal(tab);
    }, delay);
  },

  setTerminalMinimized(minimized) {
    const nav = document.getElementById("navTerminal");
    const indicator = document.getElementById("terminalMinimizedIndicator");
    if (nav) nav.classList.toggle("terminal-minimized", minimized);
    if (indicator) indicator.classList.toggle("hidden", !minimized);
  },

  minimizeTerminal() {
    this.setTerminalMinimized(true);
    UI.closeModal("terminalModal");
    this.persistTerminalTabs();
  },

  disposeTerminalTab(tab, terminate = true) {
    if (terminate && tab.sessionId) {
      API.closeTerminalSession(tab.sessionId).catch(() => {});
    }
    if (tab.heartbeatTimer !== null) {
      window.clearInterval(tab.heartbeatTimer);
      tab.heartbeatTimer = null;
    }
    if (tab.reconnectTimer !== null) {
      window.clearTimeout(tab.reconnectTimer);
      tab.reconnectTimer = null;
    }
    if (tab.stableTimer !== null) {
      window.clearTimeout(tab.stableTimer);
      tab.stableTimer = null;
    }
    const socket = tab.socket;
    tab.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Terminal tab closed");
    }
    if (tab.resizeObserver) tab.resizeObserver.disconnect();
    if (tab.instance) tab.instance.dispose();
    if (tab.container) tab.container.remove();
  },

  closeTerminalTab(tabId) {
    const index = this.terminalTabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const wasActive = this.activeTerminalTabId === tabId;
    this.disposeTerminalTab(this.terminalTabs[index]);
    this.terminalTabs.splice(index, 1);

    if (wasActive) {
      const nextTab = this.terminalTabs[Math.min(index, this.terminalTabs.length - 1)] || null;
      this.activeTerminalTabId = nextTab ? nextTab.id : null;
    }
    if (this.activeTerminalTabId) {
      this.activateTerminalTab(this.activeTerminalTabId);
    } else {
      this.terminalInstance = null;
      this.terminalFitAddon = null;
      this.terminalSocket = null;
      this.terminalResizeObserver = null;
      this.terminalPendingInput = [];
      this.terminalRequestedCwd = null;
      const header = document.getElementById("terminalHeaderTitle");
      if (header) header.textContent = t("terminal_title");
      this.renderTerminalTabs();
    }
    this.persistTerminalTabs();
  },

  closeTerminalWindow() {
    this.closeTerminalSession();
    UI.closeModal("terminalModal");
  },

  async closeTerminalSession({ terminate = true, preserveStored = false } = {}) {
    this.setTerminalMinimized(false);
    const tabs = this.terminalTabs.slice();
    const closeRequests = terminate
      ? tabs.map(tab => API.closeTerminalSession(tab.sessionId).catch(() => null))
      : [];
    tabs.forEach(tab => this.disposeTerminalTab(tab, false));
    this.terminalTabs = [];
    this.activeTerminalTabId = null;
    this.terminalInstance = null;
    this.terminalFitAddon = null;
    this.terminalSocket = null;
    this.terminalResizeObserver = null;
    this.terminalPendingInput = [];
    this.terminalRequestedCwd = null;
    const header = document.getElementById("terminalHeaderTitle");
    if (header) header.textContent = t("terminal_title");
    this.renderTerminalTabs();
    if (!preserveStored) {
      try { sessionStorage.removeItem(this.terminalStorageKey); } catch (_) {}
    }
    await Promise.allSettled(closeRequests);
  },

  sendTerminalInput(data, tab = this.getActiveTerminalTab()) {
    if (!tab) return;
    const socket = tab.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    } else if (!socket || socket.readyState === WebSocket.CONNECTING) {
      tab.pendingInput.push(data);
    }
  },

  sendTerminalResize(tab = this.getActiveTerminalTab()) {
    if (!tab || !tab.socket || tab.socket.readyState !== WebSocket.OPEN || !tab.instance) return;
    tab.socket.send(JSON.stringify({
      type: "resize",
      cols: tab.instance.cols,
      rows: tab.instance.rows
    }));
  },

  fitTerminal(tab = this.getActiveTerminalTab()) {
    if (!tab || !tab.fitAddon || !tab.instance) return;
    try {
      tab.fitAddon.fit();
      this.sendTerminalResize(tab);
    } catch (_) {}
  },

  clearTerminal() {
    const tab = this.getActiveTerminalTab();
    if (tab && tab.instance) {
      tab.instance.clear();
      if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
        tab.socket.send(JSON.stringify({ type: "clear" }));
      }
    }
  },

  runShellScript(path) {
    const normalizedPath = String(path || "");
    const scriptParts = normalizedPath.split("/").filter(part => part && part !== ".");
    if (!scriptParts.length || scriptParts.includes("..")) return;

    const scriptName = scriptParts.pop();
    if (!scriptName.toLowerCase().endsWith(".sh")) return;

    const tab = this.openTerminalModal(scriptParts.join("/"));
    if (!tab) return;

    const cwdParts = String(tab.cwd || "").split("/").filter(part => part && part !== ".");
    let commonParts = 0;
    while (commonParts < cwdParts.length && commonParts < scriptParts.length && cwdParts[commonParts] === scriptParts[commonParts]) {
      commonParts += 1;
    }
    const relativePath = [
      ...Array(cwdParts.length - commonParts).fill(".."),
      ...scriptParts.slice(commonParts),
      scriptName
    ].join("/");
    const quotedPath = "'" + relativePath.replace(/'/g, "'\\''") + "'";
    this.runTerminalCommand("bash -- " + quotedPath, tab);
  },

  runTerminalCommand(command, tab = this.getActiveTerminalTab()) {
    if (!command || !tab || !tab.instance) return;
    this.sendTerminalInput(command + "\r", tab);
    tab.instance.focus();
  },

  runDiskCheck(tab = this.getActiveTerminalTab()) {
    this.runTerminalCommand("df -h .", tab);
  },

  runFolderSizeCheck(tab = this.getActiveTerminalTab()) {
    this.runTerminalCommand("du -sh .", tab);
  },

  initDragSelect() {
    const container = document.getElementById("mainContentArea");
    if (!container) return;

    let isDown = false;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let preSelected = new Set();
    let isCtrlOrShift = false;
    let animFrame = null;

    // Create drag selection box element if not present in DOM
    let box = document.getElementById("dragSelectionBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "dragSelectionBox";
      box.className = "drag-selection-box";
      document.body.appendChild(box);
    }

    container.addEventListener("mousedown", (e) => {
      // Only left mouse button (e.button === 0)
      if (e.button !== 0) return;

      // Ignore interactive controls, modal overlays, buttons, inputs, context menus
      if (e.target.closest("button, a, input, select, textarea, .breadcrumb-crumb, .selection-bar, .modal-overlay, #contextMenu, .file-card-menu-btn, .table-btn-action, .item-checkbox, .preview-lightbox-overlay")) {
        return;
      }

      isDown = true;
      isDragging = false;
      startX = e.clientX;
      startY = e.clientY;
      isCtrlOrShift = e.ctrlKey || e.metaKey || e.shiftKey;

      if (isCtrlOrShift) {
        preSelected = new Set(AppState.selectedItems);
      } else {
        preSelected = new Set();
        // If clicking on empty space without Ctrl/Shift, deselect previous items
        if (!e.target.closest(".file-card, .file-table tbody tr")) {
          AppState.selectedItems.clear();
          AppState.lastSelectedPath = null;
          App.updateSelectionUI();
        }
      }
    });

    const onMouseMove = (e) => {
      if (!isDown) return;

      const currentX = e.clientX;
      const currentY = e.clientY;
      const dist = Math.hypot(currentX - startX, currentY - startY);

      if (!isDragging) {
        // Drag threshold of 5px to avoid interfering with regular single clicks
        if (dist > 5) {
          isDragging = true;
          this._justDragged = true;
          document.body.classList.add("select-none");
          App.hideContextMenu();
        } else {
          return;
        }
      }

      if (animFrame) cancelAnimationFrame(animFrame);
      animFrame = requestAnimationFrame(() => {
        // Calculate box dimensions
        const x1 = Math.min(startX, currentX);
        const y1 = Math.min(startY, currentY);
        const x2 = Math.max(startX, currentX);
        const y2 = Math.max(startY, currentY);

        box.style.left = `${x1}px`;
        box.style.top = `${y1}px`;
        box.style.width = `${x2 - x1}px`;
        box.style.height = `${y2 - y1}px`;
        box.style.display = "block";

        // Auto-scroll if dragging near vertical edges of the viewport
        const cRect = container.getBoundingClientRect();
        if (currentY > cRect.bottom - 45) {
          container.scrollTop += 12;
        } else if (currentY < cRect.top + 45) {
          container.scrollTop -= 12;
        }

        // Query all selectable file cards or table rows
        const items = container.querySelectorAll(".file-card, .file-table tbody tr");
        const intersecting = new Set();

        items.forEach(el => {
          const path = el.getAttribute("data-path");
          if (!path) return;

          const rect = el.getBoundingClientRect();
          // Check rectangle intersection
          const isIntersecting = !(rect.right < x1 || rect.left > x2 || rect.bottom < y1 || rect.top > y2);

          if (isIntersecting) {
            intersecting.add(path);
          }
        });

        // Determine updated selection set
        if (isCtrlOrShift) {
          AppState.selectedItems = new Set(preSelected);
          intersecting.forEach(p => {
            if (preSelected.has(p) && (e.ctrlKey || e.metaKey)) {
              AppState.selectedItems.delete(p);
            } else {
              AppState.selectedItems.add(p);
            }
          });
        } else {
          AppState.selectedItems = new Set(intersecting);
        }

        // Apply fast visual selection classes directly
        items.forEach(el => {
          const path = el.getAttribute("data-path");
          const sel = AppState.selectedItems.has(path);
          el.classList.toggle("selected", sel);
          const cb = el.querySelector(".item-checkbox");
          if (cb) cb.checked = sel;
        });

        // Update selection count and floating selection bar
        App.updateSelectionBar();
      });
    };

    const onMouseUp = () => {
      if (!isDown) return;
      isDown = false;

      if (animFrame) cancelAnimationFrame(animFrame);
      box.style.display = "none";
      document.body.classList.remove("select-none");

      if (isDragging) {
        isDragging = false;
        App.updateSelectionUI();
        setTimeout(() => {
          this._justDragged = false;
        }, 120);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }
};

// Initialize application on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  App.init();
});

