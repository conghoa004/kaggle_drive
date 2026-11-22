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
  lastSelectedPath: null,
  terminalCwd: "",
  viewMode: localStorage.getItem("kaggle_drive_view_mode") || "grid", // 'grid' | 'list'
  showHidden: false,
  searchQuery: "",
  systemStats: null,
  ports: [],
  portsError: "",
  services: [],
  servicesError: "",
  serviceTasks: {},
  servicesDirectory: { path: "", parentPath: null, entries: [], loading: false, error: "" }
};

const App = {
  serviceCredentialsModalData: null,
  serviceCredentialsRequestId: 0,
  servicesDirectoryRequestId: 0,

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
    this.renderTerminalTabs();
    const statsModal = document.getElementById("systemStatsModal");
    if (statsModal && statsModal.classList.contains("show") && AppState.systemStats) {
      this.renderSystemStatsModal(AppState.systemStats);
    }
    const portsPage = document.getElementById("portManagerPage");
    if (portsPage && !portsPage.classList.contains("hidden")) {
      this.renderPortsPage();
    }
    const servicesPage = document.getElementById("servicesStorePage");
    if (servicesPage && !servicesPage.classList.contains("hidden")) {
      this.renderServicesPage();
    }
    const credentialsModal = document.getElementById("serviceCredentialsModal");
    if (credentialsModal && credentialsModal.classList.contains("show")) {
      if (this.serviceCredentialsModalData) this.renderServiceCredentialsModal();
    }
  },

  bindEvents() {
    // Auth unauthorized listener
    window.addEventListener("auth:unauthorized", () => {
      this.closeTerminalSession();
      this.clearServicesState();
      this.showLoginView();
    });

    // Global Key shortcuts
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.hideContextMenu();
        const unsavedModal = document.getElementById("unsavedChangesModal");
        if (unsavedModal && unsavedModal.classList.contains("show")) {
          UI.closeModal("unsavedChangesModal");
          return;
        }
        const terminalModal = document.getElementById("terminalModal");
        if (terminalModal && terminalModal.classList.contains("show")) {
          this.setTerminalMinimized(true);
        }
        UI.closeAllModals();
      } else if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
        e.preventDefault();
        const searchInput = document.getElementById("searchInput");
        if (searchInput) searchInput.focus();
      } else if ((e.key === "Delete" || (e.ctrlKey && e.key === "Backspace")) && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
        if (AppState.selectedItems.size > 0 && !document.querySelector(".modal-overlay.show")) {
          e.preventDefault();
          this.promptDelete();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
        if (!document.querySelector(".modal-overlay.show")) {
          e.preventDefault();
          this.toggleSelectAll(true);
        }
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

  clearServicesState() {
    this.servicesDirectoryRequestId += 1;
    AppState.services = [];
    AppState.servicesError = "";
    AppState.serviceTasks = {};
    AppState.servicesDirectory = { path: "", parentPath: null, entries: [], loading: false, error: "" };
    this.clearServiceCredentialsModal();
    const body = document.getElementById("servicesStoreBody");
    if (body) body.replaceChildren();
  },

  clearServiceCredentialsModal() {
    this.serviceCredentialsRequestId += 1;
    this.serviceCredentialsModalData = null;
    const body = document.getElementById("serviceCredentialsBody");
    if (body) body.replaceChildren();
    const modal = document.getElementById("serviceCredentialsModal");
    if (modal) modal.classList.remove("show");
  },

  openStorageFolder() {
    this.loadDirectory(AppState.storagePath || "");
  },

  openServicesFolder() {
    this.openServicesPage();
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

    const savedNavigation = localStorage.getItem("kaggle_drive_active_navigation");
    if (savedNavigation === "navServices") {
      this.openServicesPage();
    } else if (savedNavigation === "navPorts") {
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
    this.closeTerminalSession();
    this.clearServicesState();
    try {
      await API.logout();
    } catch (_) {}
    AppState.currentPath = "";
    try {
      localStorage.removeItem("kaggle_drive_current_path");
    } catch (_) {}
    AppState.selectedItems.clear();
    this.showLoginView();
  },

  async loadDirectory(path = "", resetSearch = true) {
    this.hideContextMenu();
    this.toggleMobileSidebar(false);
    const mainContent = document.getElementById("mainContentArea");
    const portsPage = document.getElementById("portManagerPage");
    const servicesPage = document.getElementById("servicesStorePage");
    if (mainContent) mainContent.classList.remove("hidden");
    if (servicesPage) {
      servicesPage.classList.add("hidden");
      servicesPage.style.display = "none";
    }
    if (portsPage) {
      portsPage.classList.add("hidden");
      portsPage.style.display = "none";
    }
    const normalizedPath = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
    this.setActiveNavigation("navStorage");
    AppState.storagePath = normalizedPath;
    try {
      localStorage.setItem("kaggle_drive_storage_path", normalizedPath);
    } catch (_) {}
    AppState.currentPath = path;
    try {
      localStorage.setItem("kaggle_drive_current_path", path);
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
      AppState.parentPath = data.parent_path;
      AppState.rootDir = data.root_dir || AppState.rootDir;
      AppState.files = data.items || [];
      this.renderBreadcrumb();
      this.renderFiles();
    } catch (err) {
      UI.toast(`${t("error")}: ${err.message}`, "error");
    }
  },

  renderBreadcrumb() {
    const container = document.getElementById("breadcrumbContainer");
    if (!container) return;

    let html = `
      <span class="breadcrumb-crumb ${!AppState.currentPath ? 'active' : ''}" onclick="App.loadDirectory('')">
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
          <span class="breadcrumb-crumb ${isLast ? 'active' : ''}" onclick="App.loadDirectory('${accum.replace(/'/g, "\\'")}')">
            ${UI.escape(part)}
          </span>
        `;
      });
    }

    container.innerHTML = html;
  },

  renderFiles() {
    const container = document.getElementById("fileViewContainer");
    if (!container) return;

    let filtered = AppState.files;
    if (AppState.searchQuery) {
      filtered = filtered.filter(f => f.name.toLowerCase().includes(AppState.searchQuery));
    }

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
                ${['code', 'text', 'markdown', 'csv'].includes(item.category) ? `
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
      const items = AppState.files.map(f => f.path);
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
    });

    // 2. List View rows & checkboxes
    const rows = document.querySelectorAll(".file-table tbody tr");
    rows.forEach(row => {
      const p = row.getAttribute("data-path");
      const isSel = p && AppState.selectedItems.has(p);
      row.classList.toggle("selected", isSel);
      const cb = row.querySelector(".item-checkbox");
      if (cb) cb.checked = isSel;
    });

    // 3. Table Header select-all checkbox
    const selectAllCb = document.getElementById("selectAllCheckbox");
    if (selectAllCb) {
      const total = AppState.files.length;
      const count = AppState.selectedItems.size;
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
      AppState.files.forEach(f => AppState.selectedItems.add(f.path));
    } else {
      AppState.selectedItems.clear();
      AppState.lastSelectedPath = null;
    }
    this.updateSelectionUI();
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
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.duplicateItem('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-copy"></i></span>
              <span>${t("action_duplicate")}</span>
            </div>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptRename('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-pen-to-square"></i></span>
              <span>${t("action_rename")}</span>
            </div>
            <span class="context-item-kbd">F2</span>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.showProperties('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-circle-info"></i></span>
              <span>${t("action_properties")}</span>
            </div>
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
        const isEditable = (['code', 'text', 'markdown'].includes(item.category) || ['csv', 'tsv'].includes((item.extension || '').toLowerCase())) && !['xlsx', 'xls'].includes((item.extension || '').toLowerCase());
        const isArchive = ['zip', 'tar', 'archive'].includes(item.category) || ['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes((item.extension || '').toLowerCase());
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
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.duplicateItem('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-copy"></i></span>
              <span>${t("action_duplicate")}</span>
            </div>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.promptRename('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-regular fa-pen-to-square"></i></span>
              <span>${t("action_rename")}</span>
            </div>
            <span class="context-item-kbd">F2</span>
          </button>
          <button class="context-menu-item" onclick="App.hideContextMenu(); App.showProperties('${safePath}')">
            <div class="context-item-left">
              <span class="context-item-icon"><i class="fa-solid fa-circle-info"></i></span>
              <span>${t("action_properties")}</span>
            </div>
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

  downloadZip(path = "") {
    this.hideContextMenu();
    const targetPath = path || AppState.currentPath;
    window.location.href = `/api/files/download-zip?path=${encodeURIComponent(targetPath)}`;
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
      const res = await API.downloadFromUrl(url, AppState.currentPath, filename || null);
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
    UI.toast(t("compressing_multi_toast", { count: items.length }), "info", 3000);
    try {
      await API.downloadSelectedZip(items);
      UI.toast(t("compress_multi_success"), "success");
    } catch (err) {
      UI.toast(`${t("error")}: ${err.message}`, "error");
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
    const newName = input.value.trim();
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

    for (const itemPath of items) {
      try {
        await API.deleteItem(itemPath);
        successCount++;
      } catch (err) {
        UI.toast(`${t("error")} (${itemPath}): ${err.message}`, "error");
      }
    }

    if (successCount > 0) {
      UI.toast(t("delete_success_toast", { count: successCount }), "success");
      AppState.selectedItems.clear();
      this.loadDirectory(AppState.currentPath, false);
      this.refreshSystemStats();
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
    UI.closeModal("compressModal");
    UI.toast(t("compress_start_toast"), "info");

    try {
      const res = await API.compressItems(paths, archiveName, AppState.currentPath);
      UI.toast(t("compress_success_toast", { name: res.archive_name || archiveName || "archive.zip" }), "success");
      AppState.selectedItems.clear();
      this.loadDirectory(AppState.currentPath, false);
      this.refreshSystemStats();
    } catch (err) {
      UI.toast(`${t("error")}: ${err.message}`, "error");
    }
  },

  async duplicateItem(path) {
    const targetPath = path || Array.from(AppState.selectedItems)[0];
    if (!targetPath) return;

    try {
      await API.duplicateItem(targetPath);
      UI.toast(t("duplicate_success_toast"), "success");
      this.loadDirectory(AppState.currentPath, false);
    } catch (err) {
      UI.toast(err.message, "error");
    }
  },

  async extractArchive(path) {
    const targetPath = path || Array.from(AppState.selectedItems)[0];
    if (!targetPath) return;

    try {
      UI.toast(t("extract_start_toast"), "info", 3000);
      const res = await API.extractArchive(targetPath);
      UI.toast(res.message || t("extract_success_toast"), "success");
      this.loadDirectory(AppState.currentPath, false);
      this.refreshSystemStats();
    } catch (err) {
      UI.toast(err.message, "error");
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
          ${['code', 'text', 'markdown', 'csv'].includes(item.category) ? `
            <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); Editor.openFile('${safePath}')">
              <i class="fa-solid fa-pen-to-square"></i> ${t("action_edit")}
            </button>
          ` : ''}
          ${['zip', 'tar', 'archive'].includes(item.category) || ['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes((item.extension || '').toLowerCase()) ? `
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
        <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.showProperties('${safePath}')">
          <i class="fa-solid fa-circle-info"></i> ${t("action_properties")}
        </button>
        <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.copyFilePath('${safePath}')">
          <i class="fa-solid fa-folder-tree text-sky-500"></i> ${t("action_copy_path")}
        </button>
        <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.promptCompress('${safePath}')">
          <i class="fa-solid fa-box-archive text-amber-500"></i> ${t("action_compress")}
        </button>
        <button class="btn-secondary" style="text-align: left;" onclick="UI.closeModal('itemActionsModal'); App.duplicateItem('${safePath}')">
          <i class="fa-solid fa-copy"></i> ${t("action_duplicate")}
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

  async showProperties(path) {
    this.hideContextMenu();
    const modal = document.getElementById("propertiesModal");
    const title = document.getElementById("propertiesTitle");
    const body = document.getElementById("propertiesBody");
    if (!modal || !body) return;

    if (title) title.textContent = t("properties_title");
    body.textContent = t("properties_loading");
    UI.openModal("propertiesModal");

    try {
      const properties = await API.getFileProperties(path);
      body.replaceChildren();
      const numberFormat = new Intl.NumberFormat(I18n.currentLang || "vi");
      const rows = [
        { label: t("properties_name"), value: properties.name },
        { label: t("properties_type"), value: properties.is_dir ? t("folder_badge") : t("file_badge") },
        { label: t("properties_location"), value: properties.parent_path || t("properties_root") },
        ...(properties.extension ? [{ label: t("properties_extension"), value: `.${properties.extension}` }] : []),
        ...(properties.mime_type ? [{ label: t("properties_mime"), value: properties.mime_type }] : []),
        { label: t("properties_size"), value: properties.formatted_size },
        ...(properties.is_dir ? [{
          label: t("properties_contents"),
          value: `${numberFormat.format(properties.files_count)} ${t("properties_files")}, ${numberFormat.format(properties.folders_count)} ${t("properties_folders")}`
        }] : []),
        { label: t("properties_created"), value: properties.created_at || "-" },
        { label: t("properties_modified"), value: properties.modified_at || "-" },
        { label: t("properties_permissions"), value: properties.permissions || "-" }
      ];

      rows.forEach(({ label, value }) => {
        const row = document.createElement("div");
        row.className = "properties-row";
        const labelElement = document.createElement("span");
        labelElement.className = "properties-label";
        labelElement.textContent = label;
        const valueElement = document.createElement("span");
        valueElement.className = "properties-value";
        valueElement.textContent = value ?? "-";
        row.append(labelElement, valueElement);
        body.appendChild(row);
      });

      if (properties.is_dir && !properties.size_complete) {
        const note = document.createElement("p");
        note.className = "properties-note";
        note.textContent = t("properties_partial");
        body.appendChild(note);
      }
    } catch (error) {
      body.textContent = t("properties_load_error");
      UI.toast(error.message, "error");
    }
  },

  async copyFilePath(path) {
    this.hideContextMenu();
    const root = (AppState.rootDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const relativePath = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const fullPath = `${root}/${relativePath}` || "/";

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

  async openServicesPage() {
    this.toggleMobileSidebar(false);
    const mainContent = document.getElementById("mainContentArea");
    const portsPage = document.getElementById("portManagerPage");
    const servicesPage = document.getElementById("servicesStorePage");
    if (mainContent) mainContent.classList.add("hidden");
    if (portsPage) {
      portsPage.classList.add("hidden");
      portsPage.style.display = "none";
    }
    if (servicesPage) {
      servicesPage.classList.remove("hidden");
      servicesPage.style.display = "flex";
    }
    this.setActiveNavigation("navServices");
    AppState.servicesError = "";
    AppState.servicesDirectory = { path: "", parentPath: null, entries: [], loading: false, error: "" };
    await this.refreshServicesPage(false);
  },

  async refreshServicesPage(showToast = false) {
    const body = document.getElementById("servicesStoreBody");
    const button = document.getElementById("btnRefreshServices");
    const originalButton = button && showToast ? button.innerHTML : null;
    const directoryState = AppState.servicesDirectory;
    const requestId = ++this.servicesDirectoryRequestId;
    directoryState.loading = true;
    directoryState.error = "";
    if (button && showToast) {
      button.disabled = true;
      button.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> ' + t("services_store_refresh");
    }
    if (body) this.renderServicesPage();

    try {
      const [servicesResult, directoryResult] = await Promise.all([
        API.getServices(),
        API.getServicesDirectory(directoryState.path || "")
      ]);
      if (requestId !== this.servicesDirectoryRequestId) return;
      AppState.services = servicesResult.services || [];
      AppState.servicesError = "";
      AppState.services.forEach(service => {
        if (service.task) AppState.serviceTasks[service.id] = service.task;
      });
      directoryState.path = directoryResult.path || "";
      directoryState.parentPath = directoryResult.parent_path;
      directoryState.entries = directoryResult.entries || [];
      if (showToast) UI.toast(t("services_store_refresh") + " ✓", "success");
    } catch (error) {
      if (requestId !== this.servicesDirectoryRequestId) return;
      AppState.servicesError = error.message || String(error);
      directoryState.error = error.message || String(error);
    } finally {
      if (requestId === this.servicesDirectoryRequestId) {
        directoryState.loading = false;
        this.renderServicesPage();
      }
      if (button && originalButton) {
        button.innerHTML = originalButton;
        button.disabled = false;
      }
    }
  },

  async navigateServicesDirectory(path = "") {
    const directoryState = AppState.servicesDirectory;
    const requestId = ++this.servicesDirectoryRequestId;
    directoryState.path = path;
    directoryState.parentPath = null;
    directoryState.entries = [];
    directoryState.loading = true;
    directoryState.error = "";
    AppState.servicesError = "";
    this.renderServicesPage();

    try {
      const result = await API.getServicesDirectory(path);
      if (requestId !== this.servicesDirectoryRequestId) return;
      directoryState.path = result.path || "";
      directoryState.parentPath = result.parent_path;
      directoryState.entries = result.entries || [];
    } catch (error) {
      if (requestId !== this.servicesDirectoryRequestId) return;
      directoryState.error = error.message || String(error);
    } finally {
      if (requestId === this.servicesDirectoryRequestId) {
        directoryState.loading = false;
        this.renderServicesPage();
      }
    }
  },

  goUpServicesDirectory() {
    const parentPath = AppState.servicesDirectory.parentPath;
    if (typeof parentPath === "string") {
      return this.navigateServicesDirectory(parentPath);
    }
  },

  renderServicesPage() {
    const body = document.getElementById("servicesStoreBody");
    const breadcrumb = document.getElementById("servicesBreadcrumb");
    const backButton = document.getElementById("btnServicesBack");
    if (!body) return;

    const directoryState = AppState.servicesDirectory;
    const pathParts = directoryState.path ? directoryState.path.split("/") : [];
    if (backButton) backButton.disabled = typeof directoryState.parentPath !== "string";

    if (breadcrumb) {
      let currentPath = "";
      const crumbs = [{ label: "services", path: "" }];
      pathParts.forEach(part => {
        currentPath = currentPath ? currentPath + "/" + part : part;
        crumbs.push({ label: part, path: currentPath });
      });
      breadcrumb.innerHTML = crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        const pathArg = UI.escape(JSON.stringify(crumb.path));
        return (index ? '<i class="fa-solid fa-chevron-right text-[9px] text-slate-400"></i>' : '') +
          '<button type="button" class="' + (isLast ? 'text-slate-800 font-semibold' : 'hover:text-brand-700') + '" onclick="App.navigateServicesDirectory(' + pathArg + ')">' +
          (index === 0 ? '<i class="fa-solid fa-folder-tree mr-1 text-amber-500"></i>' : '') + UI.escape(crumb.label) + '</button>';
      }).join("");
    }

    if (AppState.servicesError) {
      body.innerHTML = '<div class="text-sm text-rose-700 p-4 rounded-xl bg-rose-50 border border-rose-100">' +
        t("services_store_error", { msg: UI.escape(AppState.servicesError) }) +
        '<div><button class="btn-secondary text-xs py-2 px-3 mt-3" onclick="App.refreshServicesPage(false)">' + t("services_store_retry") + '</button></div></div>';
      return;
    }
    if (directoryState.error) {
      body.innerHTML = '<div class="text-sm text-rose-700 p-4 rounded-xl bg-rose-50 border border-rose-100">' +
        t("services_folder_error", { msg: UI.escape(directoryState.error) }) +
        '<div><button class="btn-secondary text-xs py-2 px-3 mt-3" onclick="App.navigateServicesDirectory(' + UI.escape(JSON.stringify(directoryState.path || "")) + ')">' + t("services_store_retry") + '</button></div></div>';
      return;
    }
    if (directoryState.loading) {
      body.innerHTML = '<div class="flex items-center gap-2 text-sm text-slate-500 py-6"><i class="fa-solid fa-circle-notch fa-spin text-brand-600"></i><span>' + t("services_store_loading") + '</span></div>';
      return;
    }

    const activeService = pathParts.length === 1
      ? AppState.services.find(service => service.id === pathParts[0])
      : null;
    const serviceTask = activeService && (AppState.serviceTasks[activeService.id] || activeService.task);
    const serviceBusy = Boolean(serviceTask && serviceTask.status === "running");
    let serviceSummary = "";
    if (activeService) {
      const infoButton = '<button type="button" onclick="App.openServiceCredentials(' + UI.escape(JSON.stringify(activeService.id)) + ')" ' +
        (activeService.info_available && !serviceBusy ? "" : "disabled") +
        ' class="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"><i class="fa-solid fa-circle-info text-amber-500"></i>' + t("services_credentials_title") + '</button>';
      serviceSummary = '<div class="flex flex-wrap items-start justify-between gap-3 p-3 mb-3 rounded-xl border border-slate-200 bg-white">' +
        '<div><p class="font-semibold text-sm text-slate-800">' + UI.escape(activeService.name || activeService.id) + '</p>' +
        (activeService.description ? '<p class="text-xs text-slate-500 mt-1">' + UI.escape(activeService.description) + '</p>' : "") +
        (serviceTask && serviceTask.status === "failed" ? '<p class="text-xs text-rose-600 mt-2">' + t("services_action_failed", { code: Number(serviceTask.return_code || 1) }) + '</p>' : "") +
        '</div>' + infoButton + '</div>';
    }

    const actionByFilename = {
      "install.sh": "install",
      "start.sh": "start",
      "stop.sh": "stop",
      "uninstall.sh": "uninstall"
    };
    const actionIcons = { install: "fa-download", start: "fa-play", stop: "fa-stop", uninstall: "fa-trash-can" };
    const formatSize = bytes => {
      if (typeof bytes !== "number") return "—";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    };
    const rows = directoryState.entries.map(entry => {
      const entryPath = directoryState.path ? directoryState.path + "/" + entry.name : entry.name;
      const entryPathArg = UI.escape(JSON.stringify(entryPath));
      const icon = entry.type === "directory"
        ? '<i class="fa-solid fa-folder text-amber-500"></i>'
        : '<i class="fa-regular fa-file-lines text-slate-400"></i>';
      const name = entry.type === "directory"
        ? '<button type="button" class="font-medium text-slate-800 hover:text-brand-700" onclick="App.navigateServicesDirectory(' + entryPathArg + ')">' + UI.escape(entry.name) + '</button>'
        : '<span class="font-medium text-slate-700">' + UI.escape(entry.name) + '</span>';

      let actionButton = "";
      const action = pathParts.length === 1 ? actionByFilename[entry.name] : null;
      if (action && entry.type === "file" && activeService) {
        const enabled = activeService.supported && !serviceBusy && Boolean(activeService.actions && activeService.actions[action]);
        actionButton = '<button type="button" onclick="App.runServiceAction(' + UI.escape(JSON.stringify(activeService.id)) + ', \'' + action + '\')" ' +
          (enabled ? "" : "disabled") + ' class="btn-' + (action === "install" ? "primary" : action === "uninstall" ? "danger" : "secondary") +
          ' text-xs py-1.5 px-2.5 flex items-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed"><i class="fa-solid ' + actionIcons[action] + '"></i><span>' + t("services_action_" + action) + '</span></button>';
      }

      const modified = entry.modified ? new Date(entry.modified).toLocaleString() : "—";
      return '<div class="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 hover:bg-slate-50">' +
        '<div class="flex min-w-0 flex-1 items-center gap-3">' + icon + '<div class="min-w-0 truncate">' + name + '</div></div>' +
        '<span class="w-20 text-right text-[11px] text-slate-500">' + (entry.type === "file" ? formatSize(entry.size) : "—") + '</span>' +
        '<span class="hidden md:block w-40 text-right text-[11px] text-slate-500">' + UI.escape(modified) + '</span>' +
        '<div class="w-28 flex justify-end">' + actionButton + '</div></div>';
    }).join("");

    const tableHeader = '<div class="hidden md:flex items-center gap-3 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">' +
      '<span class="flex-1">' + t("col_name") + '</span><span class="w-20 text-right">' + t("col_size") + '</span>' +
      '<span class="w-40 text-right">' + t("col_date") + '</span><span class="w-28 text-right">' + t("col_actions") + '</span></div>';
    body.innerHTML = serviceSummary + tableHeader + (rows || '<div class="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">' + t("services_folder_empty") + '</div>');
  },

  async openServiceCredentials(serviceId) {
    const service = AppState.services.find(item => item.id === serviceId);
    if (!service || !service.credentials_available) return;

    const requestId = ++this.serviceCredentialsRequestId;
    this.serviceCredentialsModalData = { serviceId, loading: true };
    this.renderServiceCredentialsModal();
    UI.openModal("serviceCredentialsModal");

    try {
      const result = await API.getServiceCredentials(serviceId);
      if (requestId !== this.serviceCredentialsRequestId) return;
      this.serviceCredentialsModalData = { serviceId, credentials: result.credentials || {} };
      this.renderServiceCredentialsModal();
    } catch (error) {
      if (requestId !== this.serviceCredentialsRequestId) return;
      this.serviceCredentialsModalData = { serviceId, error: error.message || String(error) };
      this.renderServiceCredentialsModal();
    }
  },
  renderServiceCredentialsModal() {
    const data = this.serviceCredentialsModalData;
    if (!data) return;
    const title = document.getElementById("serviceCredentialsTitle");
    const body = document.getElementById("serviceCredentialsBody");
    const service = AppState.services.find(item => item.id === data.serviceId);
    const serviceName = service ? service.name || service.id : data.serviceId;
    if (title) title.textContent = t("services_credentials_title") + " " + String.fromCharCode(0x2014) + " " + serviceName;
    if (!body) return;

    if (data.loading) {
      body.innerHTML = '<div class="flex items-center gap-2 text-sm text-slate-500 py-4"><i class="fa-solid fa-circle-notch fa-spin text-brand-600"></i><span>' + t("services_credentials_loading") + '</span></div>';
      return;
    }
    if (data.error) {
      body.innerHTML = '<div class="text-sm text-rose-700 p-3 rounded-xl bg-rose-50 border border-rose-100">' +
        t("services_credentials_error", { msg: UI.escape(data.error) }) + '</div>';
      return;
    }

    const credentials = data.credentials || {};
    const labels = {
      url: "services_credential_url",
      username: "services_credential_username",
      user: "services_credential_username",
      password: "services_credential_password",
      host: "services_credential_host",
      port: "services_credential_port",
      workspace: "services_credential_workspace"
    };
    const fields = Object.entries(credentials);
    if (!fields.length) {
      body.innerHTML = '<div class="text-sm text-slate-500 py-2">' + t("services_credentials_missing") + '</div>';
      return;
    }

    body.innerHTML = '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
      fields.map(([key, value]) => {
        const label = labels[key.toLowerCase()]
          ? t(labels[key.toLowerCase()])
          : key.replace(/[_-]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
        return '<div class="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3">' +
          '<div class="text-[11px] font-semibold text-slate-500 mb-1">' + UI.escape(label) + '</div>' +
          '<div class="text-sm font-mono text-slate-800 break-all select-all cursor-text">' + UI.escape(String(value)) + '</div></div>';
      }).join("") +
      '</div>';
  },

  closeServiceCredentialsModal() {
    UI.closeModal("serviceCredentialsModal");
  },

  async runServiceAction(serviceId, action) {
    const service = AppState.services.find(item => item.id === serviceId);
    if (!service) return;
    const serviceName = service.name || service.id;
    if (action === "uninstall" && !(await UI.confirm({
      title: t("services_uninstall_title"),
      message: t("services_uninstall_confirm", { name: serviceName }),
      confirmText: t("services_action_uninstall"),
      confirmIcon: "fa-trash-can"
    }))) return;

    AppState.serviceTasks[serviceId] = { service_id: serviceId, action, status: "running" };
    this.renderServicesPage();
    try {
      const task = await API.runServiceAction(serviceId, action);
      AppState.serviceTasks[serviceId] = task;
      this.renderServicesPage();
      await this.waitForServiceTask(task.id);
    } catch (error) {
      delete AppState.serviceTasks[serviceId];
      this.renderServicesPage();
      UI.toast(error.message || String(error), "error");
    }
  },

  async waitForServiceTask(taskId) {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const task = await API.getServiceTask(taskId);
      AppState.serviceTasks[task.service_id] = task;
      this.renderServicesPage();
      if (task.status === "running") continue;

      await this.refreshServicesPage(false);
      const actionName = t("services_action_" + task.action).toLowerCase();
      if (task.status === "completed") {
        UI.toast(t("services_action_complete", { action: actionName }), "success");
      } else {
        UI.toast(t("services_action_failed", { code: Number(task.return_code || 1) }), "error");
      }
      return;
    }
  },

  async openPortsPage() {
    this.toggleMobileSidebar(false);
    const mainContent = document.getElementById("mainContentArea");
    const portsPage = document.getElementById("portManagerPage");
    const servicesPage = document.getElementById("servicesStorePage");
    if (mainContent) mainContent.classList.add("hidden");
    if (servicesPage) {
      servicesPage.classList.add("hidden");
      servicesPage.style.display = "none";
    }
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
  terminalInstance: null,
  terminalFitAddon: null,
  terminalSocket: null,
  terminalResizeObserver: null,
  terminalPendingInput: [],
  terminalRequestedCwd: null,

  getActiveTerminalTab() {
    return this.terminalTabs.find(tab => tab.id === this.activeTerminalTabId) || null;
  },

  terminalPath(cwd) {
    const suffix = (cwd || "").replace(/^\/+|\/+$/g, "");
    return suffix ? "/kaggle/working/" + suffix : "/kaggle/working";
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

  createTerminalTab(cwd = "") {
    if (this.terminalTabs.length >= 4) {
      UI.toast(t("terminal_max_tabs"), "warning");
      return null;
    }

    const usedNumbers = new Set(this.terminalTabs.map(tab => Number(tab.id.split("-").pop())));
    let number = 1;
    while (usedNumbers.has(number)) number += 1;
    const tab = {
      id: "terminal-" + number,
      title: "Terminal " + number,
      cwd: cwd || "",
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
    return tab;
  },

  openTerminalModal(targetCwd = null) {
    this.hideContextMenu();
    this.toggleMobileSidebar(false);

    const cwd = targetCwd !== null ? targetCwd : (AppState.currentPath || "");
    let tab = targetCwd !== null ? this.createTerminalTab(cwd) : this.getActiveTerminalTab();
    if (!tab) tab = this.getActiveTerminalTab() || this.createTerminalTab(cwd);

    this.setTerminalMinimized(false);
    UI.openModal("terminalModal");
    if (!tab) return;
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

    const header = document.getElementById("terminalHeaderTitle");
    if (header) header.textContent = tab.title + " — bash";
    this.renderTerminalTabs();

    requestAnimationFrame(() => {
      if (this.activeTerminalTabId !== tab.id) return;
      this.fitTerminal(tab);
      if (tab.instance) tab.instance.focus();
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
    tab.instance.onData(data => this.sendTerminalInput(data, tab));
    tab.resizeObserver = new ResizeObserver(() => this.fitTerminal(tab));
    tab.resizeObserver.observe(container);
    return true;
  },

  connectTerminal(tab = this.getActiveTerminalTab()) {
    if (!tab || !tab.instance) return;
    if (tab.reconnectTimer !== null) {
      window.clearTimeout(tab.reconnectTimer);
      tab.reconnectTimer = null;
    }
    if (tab.socket && tab.socket.readyState <= WebSocket.OPEN) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = protocol + "//" + window.location.host + "/api/system/terminal/ws?cwd=" + encodeURIComponent(tab.cwd || "");
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
      if (this.activeTerminalTabId === tab.id) tab.instance.focus();
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
  },

  disposeTerminalTab(tab) {
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
  },

  closeTerminalWindow() {
    this.closeTerminalSession();
    UI.closeModal("terminalModal");
  },

  closeTerminalSession() {
    this.setTerminalMinimized(false);
    this.terminalTabs.slice().forEach(tab => this.disposeTerminalTab(tab));
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
    if (tab && tab.instance) tab.instance.clear();
  },

  copyTerminalOutput() {
    const tab = this.getActiveTerminalTab();
    if (!tab || !tab.instance) return;
    tab.instance.selectAll();
    const text = tab.instance.getSelection();
    tab.instance.clearSelection();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      UI.toast(t("terminal_copy_toast"), "success");
    }).catch(() => {
      UI.toast(t("terminal_copy_failed"), "warning");
    });
  },

  runShellScript(path) {
    const normalizedPath = String(path || "").replace(/\\/g, "/");
    const scriptParts = normalizedPath.split("/").filter(part => part && part !== ".");
    if (!scriptParts.length || scriptParts.includes("..")) return;

    const scriptName = scriptParts.pop();
    if (!scriptName.toLowerCase().endsWith(".sh")) return;

    const tab = this.openTerminalModal(scriptParts.join("/"));
    if (!tab) return;

    const cwdParts = String(tab.cwd || "").replace(/\\/g, "/").split("/").filter(part => part && part !== ".");
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

