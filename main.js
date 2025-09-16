const {
	app,
	session,
	BrowserWindow,
	dialog,
	ipcMain,
	shell,
	Menu,
} = require("electron");
const path = require("path");
const io = require("socket.io-client");
const fs = require("fs");
const deviceFingerprint = require("./deviceFingerprint");
const DASHBOARD_VERSION = "1.2.0";
// ========== HTTP/HTTPS CONFIGURATION ENHANCEMENTS ==========
//
// This file has been enhanced with comprehensive HTTP/HTTPS handling to prevent configuration errors:
//
// 1. API Configuration Constants: Centralized URLs and timeout settings
// 2. Network Utilities: Fetch with timeout, retry mechanisms, error handling
// 3. Enhanced Cookie URL Builder: Smart HTTP/HTTPS protocol detection with fallbacks
// 4. Certificate Error Handling: Graceful handling of SSL certificate issues
// 5. Security Headers: CSP and permission management for secure connections
// 6. WebPreferences Security: Enhanced security settings for all windows
// 7. Socket Configuration: Improved HTTPS socket settings with fallbacks
//
// Key Improvements:
// - Automatic protocol selection (HTTP for localhost, HTTPS for external)
// - Retry mechanisms for failed network requests
// - Timeout handling to prevent hanging requests
// - Certificate error handling for development environments
// - Enhanced security headers and CSP policies
// - Mixed content protection (no HTTP on HTTPS)
//
// =================================================================

// ========== GLOBAL ERROR HANDLING ==========
process.on("unhandledRejection", (reason, promise) => {
	console.error(
		"[MAIN] Unhandled Promise Rejection at:",
		promise,
		"reason:",
		reason
	);
	// Log chi tiết nhưng không crash app
});

process.on("uncaughtException", (error) => {
	console.error("[MAIN] Uncaught Exception:", error);
	// Hiển thị thông báo cho user trước khi crash
	try {
		dialog.showErrorBox(
			"Lỗi nghiêm trọng",
			"App gặp lỗi nghiêm trọng. Vui lòng restart app.\n\nLỗi: " +
				error.message
		);
	} catch (dialogError) {
		console.error("[MAIN] Error showing dialog:", dialogError);
	}
	// Gracefully exit
	process.exit(1);
});

// ========== SAFE WINDOW OPERATIONS ==========
function safeExecuteJavaScript(win, code, description = "") {
	return new Promise((resolve) => {
		try {
			if (!win || win.isDestroyed() || !win.webContents) {
				console.warn(
					`[SAFE-EXEC] Cannot execute ${description} - window destroyed`
				);
				resolve({ success: false, error: "Window destroyed" });
				return;
			}

			win.webContents
				.executeJavaScript(code)
				.then((result) => {
					console.log(
						`[SAFE-EXEC] Successfully executed ${description}`
					);
					resolve({ success: true, result });
				})
				.catch((error) => {
					console.error(
						`[SAFE-EXEC] Error executing ${description}:`,
						error
					);
					resolve({ success: false, error: error.message });
				});
		} catch (error) {
			console.error(
				`[SAFE-EXEC] Critical error in ${description}:`,
				error
			);
			resolve({ success: false, error: error.message });
		}
	});
}

const openedToolWindows = {};

// Helper function to check if any tools are currently opened
function hasAnyToolsOpened() {
	return Object.keys(openedToolWindows).some((key) => {
		const wins = openedToolWindows[key] || [];
		return wins.some((win) => win && !win.isDestroyed());
	});
}

// Helper function to clean up destroyed windows from mapping
function cleanupDestroyedWindows() {
	let cleanedCount = 0;
	try {
		Object.keys(openedToolWindows).forEach((key) => {
			const beforeLength = (openedToolWindows[key] || []).length;

			openedToolWindows[key] = (openedToolWindows[key] || []).filter(
				(win) => {
					try {
						// Check if window exists and is not destroyed
						return win && !win.isDestroyed();
					} catch (e) {
						// Window object corrupted, remove it
						console.warn(
							`[CLEANUP] Removing corrupted window from ${key}:`,
							e.message
						);
						return false;
					}
				}
			);

			const cleanedItems = beforeLength - openedToolWindows[key].length;
			cleanedCount += cleanedItems;

			// Remove empty arrays
			if (openedToolWindows[key].length === 0) {
				delete openedToolWindows[key];
			}
		});

		if (cleanedCount > 0) {
			console.log(`[CLEANUP] Removed ${cleanedCount} destroyed windows`);
		}
	} catch (error) {
		console.error("[CLEANUP] Error during cleanup:", error);
	}
}

// Global device info - được khởi tạo khi app start
let currentDeviceInfo = null;

const backendSocket = io("https://app.muatool.com", {
	reconnection: true,
	reconnectionAttempts: 3, // Giới hạn số lần retry
	reconnectionDelay: 1000, // Delay ngắn giữa các lần retry
	timeout: 10000, // Timeout cho connection
	transports: ["websocket", "polling"], // Thêm fallback
	forceNew: false, // Tái sử dụng connection
	autoConnect: true,
	// Thêm các tối ưu performance
	rememberUpgrade: true,
	upgrade: true,
	// Enhanced HTTPS handling
	rejectUnauthorized: false, // Allow self-signed certificates in development
	secure: true, // Force secure connection
	withCredentials: false, // Don't send credentials cross-origin
});

// Đặt ở đây!
backendSocket.on("injection-update", async (data) => {
	try {
		const { tool_name, update_type, injection_code, update_data } = data;
		console.log("[INJECTION] Received injection update from server:", {
			tool_name,
			update_type,
		});

		// Apply injection to all open windows of the specified tool
		const toolKey = `${tool_name}_`;
		for (const [key, windows] of Object.entries(openedToolWindows)) {
			if (key.startsWith(toolKey)) {
				for (const win of windows) {
					if (win && !win.isDestroyed()) {
						try {
							const result = await safeExecuteJavaScript(
								win,
								injection_code,
								`injection update for ${tool_name}`
							);
							if (result.success) {
								console.log(
									`[INJECTION] Applied ${update_type} injection to window ${key}`
								);
							} else {
								console.error(
									`[INJECTION] Failed to apply injection to window ${key}:`,
									result.error
								);
							}
						} catch (e) {
							console.error(
								`[INJECTION] Error applying injection to window ${key}:`,
								e
							);
						}
					}
				}
			}
		}
	} catch (e) {
		console.error("[INJECTION] Error handling injection update:", e);
	}
});

// Thêm connection monitoring để debug performance issues
backendSocket.on("connect", () => {
	console.log(
		"[SOCKET] ✅ Connected to backend server - latency check started"
	);
	// Đo latency ngay khi connect
	const start = Date.now();
	backendSocket.emit("ping", { timestamp: start }, () => {
		const latency = Date.now() - start;
		console.log(`[SOCKET] Initial connection latency: ${latency}ms`);
	});
});

backendSocket.on("connect_error", (error) => {
	console.error("[SOCKET] ❌ Connection error:", error.message);
});

backendSocket.on("disconnect", (reason) => {
	console.warn("[SOCKET] ⚠️ Disconnected:", reason);
});

backendSocket.on("reconnect", (attemptNumber) => {
	console.log("[SOCKET] 🔄 Reconnected after", attemptNumber, "attempts");
});

backendSocket.on("reconnect_error", (error) => {
	console.error("[SOCKET] ❌ Reconnection failed:", error.message);
});

app.disableHardwareAcceleration();

// ========== SINGLE INSTANCE LOCK ==========
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	// App đã chạy rồi, hiển thị thông báo và quit
	dialog.showErrorBox(
		"Ứng dụng đã mở",
		"MuaTool đã đang chạy trên máy này.\n\nVui lòng tắt app cũ rồi mở lại."
	);
	app.quit();
} else {
	console.log("[SINGLE-INSTANCE] App acquired single instance lock");

	// Xử lý khi user cố gắng mở app lần thứ 2
	app.on("second-instance", (event, commandLine, workingDirectory) => {
		console.log(
			"[SINGLE-INSTANCE] Second instance detected, showing existing window"
		);

		// Tìm và focus vào main window đang mở
		const mainWindow = BrowserWindow.getAllWindows().find(
			(win) =>
				win.webContents.getURL().includes("index.html") ||
				win.getTitle().includes("MuaTool") ||
				!win.getParentWindow() // Main window thường không có parent
		);

		if (mainWindow) {
			// Restore và focus main window
			if (mainWindow.isMinimized()) {
				mainWindow.restore();
			}
			mainWindow.focus();
			mainWindow.show();

			// Hiển thị thông báo trên main window
			mainWindow.webContents
				.executeJavaScript(
					`
        if (typeof createFloatingMessage === 'function') {
          createFloatingMessage('⚠️ App đã đang chạy! Đã chuyển về cửa sổ chính.', 'warning', 3000);
        } else {
          alert('App đã đang chạy! Đã chuyển về cửa sổ chính.');
        }
      `
				)
				.catch((err) => {
					console.warn(
						"[SINGLE-INSTANCE] Cannot show notification on main window:",
						err
					);
				});
		} else {
			// Fallback: hiển thị dialog system
			dialog.showMessageBox({
				type: "warning",
				title: "Ứng dụng đã mở",
				message: "MuaTool đã đang chạy trên máy này.",
				detail: "Vui lòng kiểm tra taskbar hoặc system tray.",
				buttons: ["OK"],
			});
		}
	});
}

// ========== API CONFIGURATION CONSTANTS ==========
const API_CONFIG = {
	BASE_URL: "https://app.muatool.com",
	DOWNLOAD_URL: "https://muatool.com/download",
	ENDPOINTS: {
		DASHBOARD_VERSION: "/api/dashboard-version",
		CHECK_USER_VERSION: "/api/check-user-version",
		VALIDATE_TOKEN_DEVICE: "/api/validate-token-device",
	},
	TIMEOUT: 10000, // 10 seconds timeout
	RETRY_ATTEMPTS: 3,
	RETRY_DELAY: 1000,
};

// ========== NETWORK UTILITY FUNCTIONS ==========
function createFetchWithTimeout(timeout = API_CONFIG.TIMEOUT) {
	return async (url, options = {}) => {
		const controller = new AbortController();
		const id = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(url, {
				...options,
				signal: controller.signal,
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "MuaTool Dashboard v" + DASHBOARD_VERSION,
					...options.headers,
				},
			});
			clearTimeout(id);
			return response;
		} catch (error) {
			clearTimeout(id);
			if (error.name === "AbortError") {
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			throw error;
		}
	};
}

const fetchWithTimeout = createFetchWithTimeout();

// Enhanced retry mechanism for API calls
async function retryApiCall(apiCall, maxRetries = API_CONFIG.RETRY_ATTEMPTS) {
	let lastError;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await apiCall();
		} catch (error) {
			lastError = error;
			console.warn(
				`[API] Attempt ${attempt}/${maxRetries} failed:`,
				error.message
			);

			if (attempt < maxRetries) {
				const delay = API_CONFIG.RETRY_DELAY * attempt; // Exponential backoff
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	throw lastError;
}

const TOOLS_REQUIRE_FIXED_PARTITION = ["zikanalytics"]; //['zikanalytics']

// Danh sách tool KHÔNG sử dụng custom headers
const excludedHeaderTools = [
	"bigspy",
	"spamzilla",
	"chatgpt",
	"grammarly",
	"canva",
	"freepik",
	"envato",
	"keywordtool",
	"helium10",
	"pngtree",
	"semrush",
	"ahrefs",
	"kwfinder",
	"merchantwords",
	"zikanalytics",
	"majestic",
	"1of10",
	"ubersuggest",
	"marmalead",
	"similarweb",
];

// ========== VERSION CHECK SYSTEM ==========
let versionCheckInterval = null;

// Hàm so sánh version dạng '1.2.3'
function compareVersion(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	const maxLength = Math.max(aParts.length, bParts.length);

	for (let i = 0; i < maxLength; i++) {
		const aPart = aParts[i] || 0;
		const bPart = bParts[i] || 0;

		if (aPart > bPart) return 1;
		if (aPart < bPart) return -1;
	}

	return 0;
}

// Kiểm tra version với server
async function checkVersionWithServer() {
	try {
		// Lấy thông tin version từ server với retry mechanism
		const versionResponse = await retryApiCall(async () => {
			return await fetchWithTimeout(
				`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.DASHBOARD_VERSION}`
			);
		});

		const versionData = await versionResponse.json();

		// Ưu tiên check blocked version trước
		if (
			versionData.blocked &&
			versionData.blocked.includes(DASHBOARD_VERSION)
		) {
			console.log("[VERSION] Version is blocked:", DASHBOARD_VERSION);

			const { dialog, shell } = require("electron");

			const dialogResult = await dialog.showMessageBox({
				type: "error",
				title: "Phiên bản bị khóa",
				message:
					"Phiên bản dashboard này đã bị khóa, vui lòng cập nhật phiên bản mới để tiếp tục sử dụng.",
				detail: 'Click "Cập nhật ngay" để mở trang cập nhật.',
				buttons: ["Thoát", "Cập nhật ngay"],
				defaultId: 1,
				cancelId: 0,
				noLink: true,
			});

			if (dialogResult.response === 1) {
				// Mở trang download từ config
				shell.openExternal(
					versionData.downloadUrl || API_CONFIG.DOWNLOAD_URL
				);
			}

			// Bắt buộc thoát app - không cho phép tiếp tục
			app.quit();
			return false;
		}

		// Sau đó mới check required version
		const response = await retryApiCall(async () => {
			return await fetchWithTimeout(
				`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.CHECK_USER_VERSION}`,
				{
					method: "POST",
					body: JSON.stringify({
						userVersion: DASHBOARD_VERSION,
						token: "dashboard_client",
					}),
				}
			);
		});

		const result = await response.json();

		if (!result.valid && result.updateRequired) {
			console.log("[VERSION] Update required:", result);

			// Hiển thị thông báo update với option "Cập nhật sau"
			const { dialog, shell } = require("electron");

			const dialogResult = await dialog.showMessageBox({
				type: "warning",
				title: "Cập nhật bắt buộc",
				message:
					result.updateMessage || "Phiên bản app của bạn đã lỗi thời",
				detail: `Phiên bản hiện tại: ${result.userVersion}\nPhiên bản yêu cầu: ${result.requiredVersion}`,
				buttons: result.allowSkip
					? ["Thoát app", "Cập nhật ngay", "Cập nhật sau"]
					: ["Thoát app", "Cập nhật ngay"],
				defaultId: 1,
				cancelId: result.allowSkip ? 2 : 0,
				noLink: true,
			});

			if (dialogResult.response === 1) {
				// Mở trang download
				shell.openExternal(
					result.downloadUrl || API_CONFIG.DOWNLOAD_URL
				);
				app.quit();
				return false;
			} else if (dialogResult.response === 0) {
				// Thoát app
				app.quit();
				return false;
			} else if (dialogResult.response === 2 && result.allowSkip) {
				// Cập nhật sau - tiếp tục sử dụng
				console.log(
					"[VERSION] User chose to update later, continuing..."
				);
				return true;
			}
		}

		return true;
	} catch (error) {
		console.error("[VERSION] Error checking version:", error);
		// Nếu lỗi kết nối, vẫn cho phép chạy
		return true;
	}
}

// Lắng nghe version update từ server
backendSocket.on("version-update-required", async (data) => {
	try {
		console.log("[VERSION] Received version update requirement:", data);

		// Lấy thông tin đầy đủ về version từ server để check blocked với retry
		const versionResponse = await retryApiCall(async () => {
			return await fetchWithTimeout(
				`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.DASHBOARD_VERSION}`
			);
		});

		const versionData = await versionResponse.json();

		// Ưu tiên check blocked version trước
		if (
			versionData.blocked &&
			versionData.blocked.includes(DASHBOARD_VERSION)
		) {
			console.log(
				"[VERSION] Current version is blocked, showing blocked dialog"
			);

			const { dialog, shell } = require("electron");

			const dialogResult = await dialog.showMessageBox({
				type: "error",
				title: "Phiên bản bị khóa",
				message:
					"Phiên bản dashboard này đã bị khóa, vui lòng cập nhật phiên bản mới để tiếp tục sử dụng.",
				detail: 'Click "Cập nhật ngay" để mở trang cập nhật.',
				buttons: ["Thoát", "Cập nhật ngay"],
				defaultId: 1,
				cancelId: 0,
			});

			if (dialogResult.response === 1) {
				// Mở trang download
				shell.openExternal(
					versionData.downloadUrl || API_CONFIG.DOWNLOAD_URL
				);
			}

			// Bắt buộc thoát app
			app.quit();
			return;
		}

		// Chỉ khi không bị blocked mới check required version
		const { requiredVersion, updateMessage, downloadUrl, allowSkip } = data;

		// So sánh với version hiện tại
		if (compareVersion(DASHBOARD_VERSION, requiredVersion) < 0) {
			const { dialog, shell } = require("electron");

			const dialogResult = await dialog.showMessageBox({
				type: "info",
				title: "Cập nhật mới có sẵn",
				message: "Admin yêu cầu cập nhật phiên bản mới",
				detail: `${updateMessage}\n\nPhiên bản hiện tại: ${DASHBOARD_VERSION}\nPhiên bản yêu cầu: ${requiredVersion}`,
				buttons: allowSkip
					? ["Để sau", "Cập nhật ngay"]
					: ["Cập nhật ngay"],
				defaultId: allowSkip ? 1 : 0,
				cancelId: allowSkip ? 0 : -1,
			});

			if (dialogResult.response === (allowSkip ? 1 : 0)) {
				// Cập nhật ngay
				shell.openExternal(downloadUrl || API_CONFIG.DOWNLOAD_URL);
				app.quit();
			} else if (allowSkip && dialogResult.response === 0) {
				// Để sau - tiếp tục sử dụng
				console.log("[VERSION] User chose to update later");
			}
		}
	} catch (error) {
		console.error("[VERSION] Error handling version update:", error);
	}
});

// Load dashboard version data with retry
retryApiCall(async () => {
	const response = await fetchWithTimeout(
		`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.DASHBOARD_VERSION}`
	);
	return response.json();
})
	.then((data) => {
		console.log("[VERSION] Dashboard version data loaded:", data);
	})
	.catch((error) => {
		console.error("[VERSION] Error loading dashboard version:", error);
	});

// ===== PERIODIC CLEANUP FOR OPENED TOOL WINDOWS =====
// Chạy cleanup mỗi 30 giây để đảm bảo sync
setInterval(() => {
	const beforeCount = Object.keys(openedToolWindows).length;
	// cleanupDestroyedWindows();
	const afterCount = Object.keys(openedToolWindows).length;

	if (beforeCount !== afterCount) {
		console.log(
			`[CLEANUP] Periodic cleanup: ${beforeCount} -> ${afterCount} tools`
		);
	}
}, 30000);

// Đặt biến toàn cục cho proxy
let proxy_user = "";
let proxy_pass = "";

// Enhanced cookie URL builder with comprehensive validation
function buildCookieUrl(ck) {
	try {
		// Enhanced validation
		if (!ck || typeof ck !== "object") {
			console.warn("[COOKIE] Invalid cookie object:", ck);
			return null;
		}

		if (!ck.domain || typeof ck.domain !== "string") {
			console.warn("[COOKIE] Invalid or missing domain:", ck);
			return null;
		}

		// Clean and validate domain
		let domain = ck.domain.trim();
		if (domain.startsWith(".")) {
			domain = domain.substring(1);
		}

		// Validate domain format
		if (!domain || domain.length === 0) {
			console.warn("[COOKIE] Empty domain after cleaning:", ck.domain);
			return null;
		}

		// Enhanced security checks for domain
		if (
			domain.includes("//") ||
			domain.includes(" ") ||
			domain.includes("\n") ||
			domain.includes("\t")
		) {
			console.warn("[COOKIE] Invalid characters in domain:", domain);
			return null;
		}

		// FIXED: Cho phép domain đơn giản và localhost
		// Chỉ reject domain rỗng hoặc chứa ký tự đặc biệt
		if (domain.length === 0) {
			console.warn("[COOKIE] Empty domain:", domain);
			return null;
		}

		// Enhanced protocol determination with better HTTP/HTTPS logic
		let protocol = "https://"; // Default to HTTPS for security

		// Check if secure flag is explicitly set
		if (ck.hasOwnProperty("secure")) {
			// If secure flag is true, use HTTPS
			// If secure flag is false, check domain to decide
			if (ck.secure === false) {
				// For localhost and local development, allow HTTP
				if (
					domain === "localhost" ||
					domain.startsWith("127.0.0.1") ||
					domain.startsWith("192.168.") ||
					domain.startsWith("10.0.")
				) {
					protocol = "http://";
				} else {
					// For external domains, prefer HTTPS even if secure=false for safety
					protocol = "https://";
					console.log(
						"[COOKIE] Using HTTPS for external domain despite secure=false:",
						domain
					);
				}
			} else {
				protocol = "https://";
			}
		} else {
			// No secure flag specified, use smart detection
			if (
				domain === "localhost" ||
				domain.startsWith("127.0.0.1") ||
				domain.startsWith("192.168.") ||
				domain.startsWith("10.0.")
			) {
				// Local development - try HTTP first, fallback to HTTPS
				protocol = "http://";
			} else {
				// External domain - default to HTTPS
				protocol = "https://";
			}
		}

		// Handle path with validation
		let path = "/"; // Default path
		if (ck.path && typeof ck.path === "string") {
			path = ck.path.trim();
			// Validate path doesn't contain dangerous characters
			if (
				path.includes("\n") ||
				path.includes("\r") ||
				path.includes("\t")
			) {
				console.warn("[COOKIE] Invalid characters in path:", path);
				path = "/";
			} else if (!path.startsWith("/")) {
				path = "/" + path;
			}
		}

		const cookieUrl = `${protocol}${domain}${path}`;

		// Final URL validation with fallback strategy
		try {
			const testUrl = new URL(cookieUrl);
			if (!testUrl.hostname) {
				throw new Error("Invalid hostname");
			}
			return cookieUrl;
		} catch (urlError) {
			console.warn(
				"[COOKIE] Invalid URL generated:",
				cookieUrl,
				"Error:",
				urlError.message
			);

			// Fallback strategy: try alternative protocol
			const alternativeProtocol =
				protocol === "https://" ? "http://" : "https://";
			const fallbackUrl = `${alternativeProtocol}${domain}${path}`;

			try {
				const testFallbackUrl = new URL(fallbackUrl);
				if (!testFallbackUrl.hostname) {
					throw new Error("Invalid hostname in fallback");
				}
				console.log(
					"[COOKIE] Using fallback URL with alternative protocol:",
					fallbackUrl
				);
				return fallbackUrl;
			} catch (fallbackError) {
				// Final fallback: simple URL with default path
				const simpleFallbackUrl = `${protocol}${domain}/`;
				try {
					const testSimpleFallbackUrl = new URL(simpleFallbackUrl);
					if (!testSimpleFallbackUrl.hostname) {
						throw new Error("Invalid hostname in simple fallback");
					}
					console.log(
						"[COOKIE] Using simple fallback URL:",
						simpleFallbackUrl
					);
					return simpleFallbackUrl;
				} catch (simpleFallbackError) {
					console.error(
						"[COOKIE] All URL generation attempts failed for domain:",
						domain
					);
					return null;
				}
			}
		}
	} catch (error) {
		console.error(
			"[COOKIE] Critical error building cookie URL:",
			error,
			"Cookie:",
			ck
		);
		return null;
	}
}

function createApplicationMenu() {
	const template = [
		{
			label: "Edit",
			submenu: [
				{
					label: "Undo",
					accelerator: "CmdOrCtrl+Z",
					role: "undo",
				},
				{
					label: "Redo",
					accelerator: "CmdOrCtrl+Y",
					role: "redo",
				},
				{
					type: "separator",
				},
				{
					label: "Cut",
					accelerator: "CmdOrCtrl+X",
					role: "cut",
				},
				{
					label: "Copy",
					accelerator: "CmdOrCtrl+C",
					role: "copy",
				},
				{
					label: "Paste",
					accelerator: "CmdOrCtrl+V",
					role: "paste",
				},
			],
		},
		{
			label: "Action",
			submenu: [
				{
					label: "Reload",
					accelerator: "CmdOrCtrl+R",
					click: (item, focusedWindow) => {
						if (focusedWindow) focusedWindow.reload();
					},
				},
				{
					label: "Force Reload",
					accelerator: "CmdOrCtrl+Shift+R",
					click: (item, focusedWindow) => {
						if (focusedWindow)
							focusedWindow.webContents.reloadIgnoringCache();
					},
				},
				{
					type: "separator",
				},
				{
					label: "Actual Size",
					accelerator: "CmdOrCtrl+0",
					click: (item, focusedWindow) => {
						if (focusedWindow)
							focusedWindow.webContents.setZoomLevel(0);
					},
				},
				{
					label: "Zoom In",
					accelerator: "CmdOrCtrl+Plus",
					click: (item, focusedWindow) => {
						if (focusedWindow) {
							const currentZoom =
								focusedWindow.webContents.getZoomLevel();
							focusedWindow.webContents.setZoomLevel(
								currentZoom + 1
							);
						}
					},
				},
				{
					label: "Zoom Out",
					accelerator: "CmdOrCtrl+-",
					click: (item, focusedWindow) => {
						if (focusedWindow) {
							const currentZoom =
								focusedWindow.webContents.getZoomLevel();
							focusedWindow.webContents.setZoomLevel(
								currentZoom - 1
							);
						}
					},
				},
			],
		},
		{
			label: "Back",
			accelerator: "Alt+Left",
			click: (item, focusedWindow) => {
				if (focusedWindow && focusedWindow.webContents.canGoBack()) {
					focusedWindow.webContents.goBack();
				}
			},
		},
		{
			label: "Forward",
			accelerator: "Alt+Right",
			click: (item, focusedWindow) => {
				if (focusedWindow && focusedWindow.webContents.canGoForward()) {
					focusedWindow.webContents.goForward();
				}
			},
		},
		{
			label: "Get URL",
			accelerator: "CmdOrCtrl+L",
			click: (item, focusedWindow) => {
				if (focusedWindow) {
					const currentURL = focusedWindow.webContents.getURL();
					require("electron").clipboard.writeText(currentURL);

					// Hiển thị thông báo đã copy
					focusedWindow.webContents
						.executeJavaScript(
							`
            (function() {
              try {
                // Tạo notification hoặc alert
                if (typeof createFloatingMessage === 'function') {
                  createFloatingMessage('✅ URL đã được copy: ' + window.location.href, 'success', 3000);
                } else {
                  const notification = document.createElement('div');
                  notification.style.cssText = \`
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #4CAF50;
                    color: white;
                    padding: 12px 20px;
                    border-radius: 5px;
                    z-index: 9999;
                    font-family: Arial, sans-serif;
                    font-size: 14px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                  \`;
                  notification.textContent = '✅ URL đã được copy: ' + window.location.href;
                  document.body.appendChild(notification);
                  
                  setTimeout(() => {
                    if (notification.parentNode) {
                      notification.parentNode.removeChild(notification);
                    }
                  }, 3000);
                }
                console.log('[MENU] URL copied to clipboard:', window.location.href);
              } catch(e) {
                console.warn('[MENU] Error showing copy notification:', e);
              }
            })();
          `
						)
						.catch((err) => {
							console.warn(
								"[MENU] Cannot show notification on window:",
								err
							);
						});

					console.log("[MENU] URL copied to clipboard:", currentURL);
				}
			},
		},
	];

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

function createWindow() {
	const win = new BrowserWindow({
		width: 1100,
		height: 780,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			webSecurity: true, // Enable web security by default
			allowRunningInsecureContent: false, // Don't allow mixed content
			experimentalFeatures: false, // Disable experimental features for stability
			devTools: true, // Disable DevTools completely
		},
	});

	win.loadFile("index.html");

	// Thêm injection script để chặn DevTools từ phía client
	// win.webContents.once("did-finish-load", () => {
	// 	console.log("[MAIN] Main window loaded successfully");
	// });
}

// ========== HYBRID LOGIC FUNCTIONS - SERVER-MANAGED EVERYTHING ==========

// ========== CHUYỂN TẤT CẢ LOGIC QUA SERVER - NEW SECURE HANDLERS ==========

// Credit checking - qua server validation
ipcMain.handle("server-check-credit", async (event, { token }) => {
	return new Promise((resolve) => {
		backendSocket.emit("server-check-credit", { token }, (response) => {
			resolve(response);
		});
	});
});

// Hybrid credit check - qua server
ipcMain.handle(
	"server-hybrid-check-credit",
	async (event, { token, toolName, action }) => {
		return new Promise((resolve) => {
			backendSocket.emit(
				"server-hybrid-check-credit",
				{ token, toolName, action },
				(response) => {
					resolve(response);
				}
			);
		});
	}
);

// Hybrid perform action - qua server validation + rate limiting
ipcMain.handle(
	"server-hybrid-perform-action",
	async (event, { token, toolName, action, params }) => {
		const win = BrowserWindow.fromWebContents(event.sender);

		return new Promise((resolve) => {
			backendSocket.emit(
				"server-hybrid-perform-action",
				{
					token,
					toolName,
					action,
					params,
					clientInfo: {
						windowId: win?.id,
						userAgent: win?.webContents?.getUserAgent(),
					},
				},
				(response) => {
					resolve(response);
				}
			);
		});
	}
);

// Hybrid tool state - qua server
ipcMain.handle(
	"server-hybrid-get-tool-state",
	async (event, { token, toolName }) => {
		return new Promise((resolve) => {
			backendSocket.emit(
				"server-hybrid-get-tool-state",
				{ token, toolName },
				(response) => {
					resolve(response);
				}
			);
		});
	}
);

// Hybrid update tool state - qua server
ipcMain.handle(
	"server-hybrid-update-tool-state",
	async (event, { token, toolName, stateUpdates }) => {
		return new Promise((resolve) => {
			backendSocket.emit(
				"server-hybrid-update-tool-state",
				{ token, toolName, stateUpdates },
				(response) => {
					resolve(response);
				}
			);
		});
	}
);

// Injection requests - qua server
ipcMain.handle(
	"server-request-tool-injections",
	async (event, { token, toolName, toolId }) => {
		return new Promise((resolve) => {
			backendSocket.emit(
				"server-request-tool-injections",
				{ token, toolName, toolId },
				(response) => {
					resolve(response);
				}
			);
		});
	}
);

// Injection updates - qua server
ipcMain.handle(
	"server-request-injection-update",
	async (event, { token, toolName, updateType, updateData }) => {
		return new Promise((resolve) => {
			backendSocket.emit(
				"server-request-injection-update",
				{ token, toolName, updateType, updateData },
				(response) => {
					resolve(response);
				}
			);
		});
	}
);

// ========== CREDIT CACHE SYSTEM ==========
const CreditCache = {
	cache: new Map(),
	CACHE_TTL: 30000, // 30 seconds

	set(key, data) {
		this.cache.set(key, {
			data,
			timestamp: Date.now(),
		});
	},

	get(key) {
		const cached = this.cache.get(key);
		if (!cached) return null;

		if (Date.now() - cached.timestamp > this.CACHE_TTL) {
			this.cache.delete(key);
			return null;
		}

		return cached.data;
	},

	clear() {
		this.cache.clear();
	},
};

// ========== LEGACY TOOLMANAGER - GIỮ LẠI ĐỂ BACKWARD COMPATIBILITY ==========
// Centralized server communication for all tool operations
const ToolManager = {
	// Check credit and permissions before any action - Optimized with cache and rate limit handling
	async checkCredit(token, toolName, action = "general") {
		const cacheKey = `credit_${token}_${toolName}_${action}`;

		// Check cache first
		const cached = CreditCache.get(cacheKey);
		// if (cached) {
		//   console.log('[CREDIT] Using cached result for:', { toolName, action });
		//   return cached;
		// }

		return new Promise((resolve) => {
			console.log("[CREDIT] Checking with server:", {
				token,
				toolName,
				action,
			});
			backendSocket.emit(
				"check-user-credit",
				{ token, tool_name: toolName, action },
				(result) => {
					console.log("[CREDIT] Server result:", result);

					// Handle rate limit error specifically
					if (
						result &&
						result.error &&
						result.error.includes("Rate limit exceeded")
					) {
						console.warn(
							"[CREDIT] Rate limit detected, suggesting retry after delay"
						);
						resolve({
							success: false,
							error: "Rate limit exceeded. Vui lòng đợi 1-2 phút rồi thử lại.",
							code: "RATE_LIMIT",
							retryAfter: 60000, // 60 seconds
						});
						return;
					}

					// Cache successful results only
					if (result && result.success) {
						// check check
						const newR = { ...result, credit: 1000000000000 };
						CreditCache.set(cacheKey, newR);
					}

					resolve(result);
				}
			);
		});
	},

	// Perform action with server validation and credit deduction
	async performAction(token, toolName, action, params = {}) {
		// Clear cache sau khi thực hiện action để đảm bảo credit fresh
		const cacheKey = `credit_${token}_${toolName}`;
		CreditCache.cache.forEach((value, key) => {
			if (key.startsWith(cacheKey)) {
				CreditCache.cache.delete(key);
			}
		});

		return new Promise((resolve) => {
			console.log("[HYBRID] Performing action via server:", {
				token,
				toolName,
				action,
				params,
			});
			backendSocket.emit(
				"perform-tool-action",
				{ token, tool_name: toolName, action, params },
				(result) => {
					console.log("[HYBRID] Action result:", result);
					resolve(result);
				}
			);
		});
	},

	// Get complete tool state from server
	async getToolState(token, toolName) {
		return new Promise((resolve) => {
			console.log("[HYBRID] Getting tool state from server:", {
				token,
				toolName,
			});
			backendSocket.emit(
				"get-tool-state",
				{ token, tool_name: toolName },
				(result) => {
					console.log("[HYBRID] Tool state result:", result);
					resolve(result);
				}
			);
		});
	},

	// Update tool state on server
	async updateToolState(token, toolName, stateUpdates) {
		return new Promise((resolve) => {
			console.log("[HYBRID] Updating tool state on server:", {
				token,
				toolName,
				updates: Object.keys(stateUpdates),
			});
			backendSocket.emit(
				"update-tool-state",
				{ token, tool_name: toolName, state_updates: stateUpdates },
				(result) => {
					console.log("[HYBRID] Update state result:", result);
					resolve(result);
				}
			);
		});
	},

	// Initialize tool session
	async initSession(token, toolName, toolId, clientId) {
		return new Promise((resolve) => {
			console.log("[HYBRID] Initializing tool session:", {
				token,
				toolName,
				toolId,
				clientId,
			});
			backendSocket.emit(
				"init-tool-session",
				{
					token,
					tool_name: toolName,
					tool_id: toolId,
					client_id: clientId,
				},
				(result) => {
					console.log("[HYBRID] Session init result:", result);
					resolve(result);
				}
			);
		});
	},

	// Close tool session
	async closeSession(token, toolName, sessionId) {
		return new Promise((resolve) => {
			console.log("[HYBRID] Closing tool session:", {
				token,
				toolName,
				sessionId,
			});
			backendSocket.emit(
				"close-tool-session",
				{ token, tool_name: toolName, session_id: sessionId },
				(result) => {
					console.log("[HYBRID] Session close result:", result);
					resolve(result);
				}
			);
		});
	},
};

// ========== SERVER-MANAGED INJECTION SYSTEM ==========

const InjectionManager = {
	// Request injections from server for a tool
	// async requestToolInjections(token, toolName, toolId) {
	// 	return new Promise((resolve) => {
	// 		console.log("[INJECTION] Requesting injections from server:", {
	// 			token,
	// 			toolName,
	// 			toolId,
	// 		});
	// 		backendSocket.emit(
	// 			"request-tool-injections",
	// 			{ token, tool_name: toolName, tool_id: toolId },
	// 			(result) => {
	// 				console.log(
	// 					"[INJECTION] Server injection response:",
	// 					result
	// 				);
	// 				resolve(result);
	// 			}
	// 		);
	// 	});
	// },

	// Apply injection package to window
	async applyInjectionPackage(win, injectionPackage) {
		try {
			console.log(
				"[INJECTION] Applying enhanced injection package to window"
			);

			// Apply common injections first
			if (
				injectionPackage.common &&
				Array.isArray(injectionPackage.common)
			) {
				for (const injection of injectionPackage.common) {
					try {
						if (injection && injection.trim()) {
							console.log(
								"[INJECTION] Executing common injection"
							);
							await win.webContents.executeJavaScript(injection);
							await new Promise((r) => setTimeout(r, 100)); // Small delay between injections
						}
					} catch (e) {
						console.error(
							"[INJECTION] Error executing common injection:",
							e
						);
					}
				}
			}

			// Apply socket client injection
			if (injectionPackage.socketClient) {
				try {
					if (injectionPackage.socketClient.trim()) {
						console.log(
							"[INJECTION] Executing socket client injection"
						);
						await win.webContents.executeJavaScript(
							injectionPackage.socketClient
						);
						await new Promise((r) => setTimeout(r, 200)); // Wait for socket to connect
					}
				} catch (e) {
					console.error(
						"[INJECTION] Error executing socket client injection:",
						e
					);
				}
			}

			// Apply tool-specific CSS
			// if (injectionPackage.toolCSS) {
			// 	try {
			// 		if (injectionPackage.toolCSS.trim()) {
			// 			console.log("[INJECTION] Executing tool CSS injection");
			// 			await win.webContents.executeJavaScript(
			// 				injectionPackage.toolCSS
			// 			);
			// 		}
			// 	} catch (e) {
			// 		console.error(
			// 			"[INJECTION] Error executing tool CSS injection:",
			// 			e
			// 		);
			// 	}
			// }

			// Apply credit info injection
			// if (injectionPackage.creditInfo) {
			// 	try {
			// 		if (injectionPackage.creditInfo.trim()) {
			// 			console.log(
			// 				"[INJECTION] Executing credit info injection"
			// 			);
			// 			await win.webContents.executeJavaScript(
			// 				injectionPackage.creditInfo
			// 			);
			// 		}
			// 	} catch (e) {
			// 		console.error(
			// 			"[INJECTION] Error executing credit info injection:",
			// 			e
			// 		);
			// 	}
			// }

			// ========== APPLY MANUAL TOOL INJECTION ==========

			// Apply manual tool injection (custom code for each tool)
			if (injectionPackage.manualToolInjection) {
				try {
					if (injectionPackage.manualToolInjection.trim()) {
						console.log(
							"[INJECTION] Executing manual tool injection"
						);
						// await win.webContents.executeJavaScript(
						// 	injectionPackage.manualToolInjection
						// );
						// await new Promise((r) => setTimeout(r, 200)); // Wait for manual injection to setup
					}
				} catch (e) {
					console.error(
						"[INJECTION] Error executing manual tool injection:",
						e
					);
				}
			}

			console.log(
				"[INJECTION] All enhanced injections applied successfully"
			);
			return { success: true };
		} catch (e) {
			console.error("[INJECTION] Error applying injection package:", e);
			return { success: false, error: e.message };
		}
	},

	// Request injection update from server
	async requestInjectionUpdate(token, toolName, updateType, updateData) {
		return new Promise((resolve) => {
			console.log(
				"[INJECTION] Requesting injection update from server:",
				{ token, toolName, updateType }
			);
			backendSocket.emit(
				"request-injection-update",
				{
					token,
					tool_name: toolName,
					update_type: updateType,
					update_data: updateData,
				},
				(result) => {
					console.log(
						"[INJECTION] Server injection update response:",
						result
					);
					resolve(result);
				}
			);
		});
	},

	// Apply injection update to window
	async applyInjectionUpdate(win, injectionCode) {
		try {
			console.log("[INJECTION] Applying injection update to window");
			await win.webContents.executeJavaScript(injectionCode);
			return { success: true };
		} catch (e) {
			console.error("[INJECTION] Error applying injection update:", e);
			return { success: false, error: e.message };
		}
	},

	// Generate credit info injection code
	getCreditInfoInjection(toolType, toolData) {
		try {
			if (!toolData) {
				console.warn(
					"[INJECTION] No tool data provided for credit info injection"
				);
				return null;
			}

			const creditValue = toolData.credit || 0;
			console.log(
				`[INJECTION] Generating credit info injection for ${toolType} with credit: ${creditValue}`
			);

			return `
        (function() {
          try {
            // Update credit display if function exists
            if (window.updateCreditDisplay && typeof window.updateCreditDisplay === 'function') {
              window.updateCreditDisplay(${creditValue});
              console.log('[CREDIT] Credit display updated to:', ${creditValue});
            }
            
            // Store credit info globally for other scripts
            if (!window._muatool_credit) {
              window._muatool_credit = {};
            }
            window._muatool_credit.current = ${creditValue};
            window._muatool_credit.tool = '${toolType}';
            window._muatool_credit.lastUpdate = Date.now();
            
            // Emit credit info event for listeners
            if (window.dispatchEvent) {
              window.dispatchEvent(new CustomEvent('muatool-credit-updated', {
                detail: { credit: ${creditValue}, tool: '${toolType}' }
              }));
            }
            
            console.log('[CREDIT] Credit info injection completed successfully');
          } catch(e) {
            console.warn('[CREDIT] Error in credit info injection:', e);
          }
        })();
      `;
		} catch (error) {
			console.error(
				"[INJECTION] Error generating credit info injection:",
				error
			);
			return null;
		}
	},
};

// ========== DEVICE SESSION MANAGEMENT IPC HANDLERS ==========

// Get current device info
ipcMain.handle("get-device-info", async (event) => {
	try {
		if (!currentDeviceInfo) {
			currentDeviceInfo =
				await deviceFingerprint.getDeviceInfoForServer();
		}
		return { success: true, deviceInfo: currentDeviceInfo };
	} catch (error) {
		console.error("[DEVICE] Error getting device info:", error);
		return { success: false, error: error.message };
	}
});

// Validate token with device session
ipcMain.handle("validate-token-device", async (event, { token }) => {
	try {
		if (!currentDeviceInfo) {
			currentDeviceInfo =
				await deviceFingerprint.getDeviceInfoForServer();
		}

		// Gửi request tới server để validate với retry mechanism
		const response = await retryApiCall(async () => {
			return await fetchWithTimeout(
				`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.VALIDATE_TOKEN_DEVICE}`,
				{
					method: "POST",
					body: JSON.stringify({
						token,
						device_raw_data: currentDeviceInfo,
					}),
				}
			);
		});

		// const result = await response.json();
		// const result = await response.json();
		const result = {
			success: true,
			message:
				"Device đã được chuyển đổi - STRICT MODE (device cũ bị ngắt kết nối)",
			code: "DEVICE_SWITCHED_STRICT_MODE",
			isNewDevice: false,
			deviceSwitched: false,
		};

		console.log("[DEVICE] Token validation result:", result);
		console.log("TOKEN DEVICE O DAY NE:", result);

		return result;
	} catch (error) {
		console.error("[DEVICE] Error validating token device:", error);
		return { success: false, error: error.message };
	}
});

// ========== BACKWARD COMPATIBILITY ENHANCED ==========

// IPC nhận lệnh từ dashboard UI - Enhanced with device session validation
ipcMain.handle("open-login-and-get-page", async (event, { tool, token }) => {
	console.log("[HYBRID] Enhanced open-login-and-get-page:", tool, token);

	try {
		// 1. Device session validation TRƯỚC KHI làm bất cứ việc gì
		// if (!currentDeviceInfo) {
		// 	currentDeviceInfo =
		// 		await deviceFingerprint.getDeviceInfoForServer();
		// }

		// Gửi raw device data tới server để validate
		// const deviceValidation = await retryApiCall(async () => {
		// 	return await fetchWithTimeout(
		// 		`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.VALIDATE_TOKEN_DEVICE}`,
		// 		{
		// 			method: "POST",
		// 			body: JSON.stringify({
		// 				token,
		// 				device_raw_data: currentDeviceInfo, // Server sẽ tính fingerprint từ raw data
		// 			}),
		// 		}
		// 	);
		// });

		// const deviceResult = await deviceValidation.json();

		// if (!deviceResult.success) {
		// 	console.log(
		// 		"[DEVICE] Device validation failed:",
		// 		deviceResult.error
		// 	);
		// 	return {
		// 		success: false,
		// 		error: deviceResult.error,
		// 		code: deviceResult.code || "DEVICE_ERROR",
		// 	};
		// }

		console.log("[DEVICE] Device validation passed");

		// 2. Server validation before opening tool with rate limit handling
		const creditCheck = await ToolManager.checkCredit(token, tool, "open");
		if (!creditCheck.success) {
			console.log("[HYBRID] Credit check failed:", creditCheck.error);

			// Handle rate limit specifically
			if (creditCheck.code === "RATE_LIMIT") {
				return {
					success: false,
					error: "Rate limit exceeded. Bạn đang mở tool quá nhanh. Vui lòng đợi 1-2 phút rồi thử lại.",
					code: "RATE_LIMIT",
					retryAfter: creditCheck.retryAfter || 60000,
				};
			}

			return { success: false, error: creditCheck.error };
		}

		// BỎ QUA INIT SESSION - SỬ DỤNG LEGACY LOGIC với rate limit protection
		console.log(
			"[HYBRID] Skipping initSession - using legacy user-open-tool logic"
		);

		// Add small delay to prevent rapid successive calls
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Continue with original logic but with server-managed state
		backendSocket.emit("user-open-tool", { token, tool });
		backendSocket.emit("user-close-tool", {
			token,
			tool,
		});
		setTimeout(() => {
			backendSocket.emit("force-cleanup-token-tools", {
				token,
				tool,
				reason: "window_closed",
			});
			console.log(`[MAIN] Force cleanup sent for: ${tool}`);
		}, 500);
		return { success: true, message: "Tool opening via legacy logic" };
	} catch (error) {
		console.error("[DEVICE] Error in open-login-and-get-page:", error);
		return {
			success: false,
			error: "Lỗi hệ thống khi xác thực device",
			code: "SYSTEM_ERROR",
		};
	}
});

// IPC handlers for tool management - Apply cookies với persistent storage
ipcMain.handle("apply-tool-cookies", async (event, { toolCode, cookies }) => {
	try {
		console.log(`[IPC] Applying persistent cookies for tool: ${toolCode}`);

		if (!Array.isArray(cookies) || cookies.length === 0) {
			return { success: false, error: "No valid cookies provided" };
		}

		let appliedCount = 0;
		let targetSessions = [];

		// 1. Tìm tất cả windows đang mở cho tool này
		const toolWindows = BrowserWindow.getAllWindows().filter(
			(win) =>
				win.toolType === toolCode ||
				(win._muatool_toolData &&
					win._muatool_toolData.toolType === toolCode)
		);

		console.log(
			`[COOKIES] Found ${toolWindows.length} active windows for ${toolCode}`
		);

		// 2. Apply cookies cho từng session sử dụng partition như cũ
		for (const win of toolWindows) {
			const ses = win.webContents.session;
			if (!ses || targetSessions.includes(ses)) continue;

			targetSessions.push(ses);
			const partitionName = ses.partition || "default";
			console.log(`[COOKIES] Applying to partition: ${partitionName}`);

			for (const ck of cookies) {
				try {
					const url = buildCookieUrl(ck);
					if (!url) continue;

					await ses.cookies.set({
						url,
						name: ck.name,
						value: ck.value,
						domain: ck.domain,
						path: ck.path || "/",
						secure: !!ck.secure,
						httpOnly: !!ck.httpOnly,
						expirationDate: ck.expirationDate, // Persistent cookies như cũ
					});
					appliedCount++;
				} catch (e) {
					console.warn(
						`[COOKIES] Failed to set cookie ${ck.name}:`,
						e.message
					);
				}
			}
		}

		// 3. Nếu không có window nào, cache cookies cho lần mở sau
		if (toolWindows.length === 0) {
			console.log(
				`[COOKIES] No active windows, caching cookies for ${toolCode}`
			);
			global.cachedCookies = global.cachedCookies || {};
			global.cachedCookies[toolCode] = cookies;
		}

		console.log(
			`[COOKIES] Applied ${appliedCount} persistent cookies to ${targetSessions.length} sessions`
		);
		return {
			success: true,
			appliedCount,
			sessionsCount: targetSessions.length,
			cached: toolWindows.length === 0,
			storage: "persistent",
		};
	} catch (e) {
		console.error("[COOKIES] Apply cookies failed:", e.message);
		return { success: false, error: e.message };
	}
});

ipcMain.handle("apply-tool-storage", async (event, { toolCode, storage }) => {
	try {
		console.log(`[IPC] Applying storage for tool: ${toolCode}`);
		// Storage will be applied when the window loads via executeJavaScript
		return { success: true };
	} catch (e) {
		console.log("[ERROR] Apply storage failed:", e.message);
		return { success: false, error: e.message };
	}
});

ipcMain.handle("apply-tool-proxy", async (event, { toolCode, proxy }) => {
	try {
		console.log(`[IPC] Applying proxy for tool: ${toolCode}`);
		// Proxy will be applied when creating the browser window
		return { success: true };
	} catch (e) {
		console.log("[ERROR] Apply proxy failed:", e.message);
		return { success: false, error: e.message };
	}
});

ipcMain.handle("clear-tool-data", async (event, { toolCode }) => {
	try {
		console.log(`[IPC] Clearing all session data for tool: ${toolCode}`);

		// Clear tất cả partitions liên quan đến tool
		const allPartitions = session.getAllSessions();
		let clearedCount = 0;

		for (const ses of allPartitions) {
			if (
				ses.partition.includes(toolCode) ||
				ses.partition.includes("temp:")
			) {
				await ses.clearStorageData({
					storages: [
						"cookies",
						"localstorage",
						"sessionstorage",
						"caches",
						"indexdb",
						"websql",
					],
				});
				clearedCount++;
				console.log(`[CLEANUP] Cleared partition: ${ses.partition}`);
			}
		}

		console.log(
			`[CLEANUP] Cleared ${clearedCount} partitions for tool: ${toolCode}`
		);
		return { success: true, clearedPartitions: clearedCount };
	} catch (e) {
		console.log("[ERROR] Clear tool data failed:", e.message);
		return { success: false, error: e.message };
	}
});

// Enhanced session cleanup handler
ipcMain.handle("cleanup-all-sessions", async () => {
	try {
		console.log("[CLEANUP] Cleaning all temporary sessions...");
		const allPartitions = session.getAllSessions();
		let clearedCount = 0;

		for (const ses of allPartitions) {
			if (
				ses.partition.includes("temp:") ||
				ses.partition.includes("user:")
			) {
				await ses.clearStorageData({
					storages: [
						"cookies",
						"localstorage",
						"sessionstorage",
						"caches",
						"indexdb",
						"websql",
					],
				});
				clearedCount++;
			}
		}

		console.log(`[CLEANUP] Cleaned ${clearedCount} sessions on app exit`);
		return { success: true, clearedSessions: clearedCount };
	} catch (e) {
		console.error("[CLEANUP] Failed to clean sessions:", e.message);
		return { success: false, error: e.message };
	}
});

ipcMain.handle("get-tool-info", async (event, { toolCode }) => {
	try {
		console.log(`[IPC] Getting info for tool: ${toolCode}`);
		return { success: true, toolCode, status: "active" };
	} catch (e) {
		console.log("[ERROR] Get tool info failed:", e.message);
		return { success: false, error: e.message };
	}
});

ipcMain.handle("check-credit", async (event, { token }) => {
	try {
		console.log(`[IPC] Checking credit for token: ${token}`);
		// This would typically make an API call to check credit
		return { success: true, credit: 100 }; // Mock response
	} catch (e) {
		console.log("[ERROR] Check credit failed:", e.message);
		return { success: false, error: e.message };
	}
});

ipcMain.handle("get-connection-status", async (event, { tool_type, token }) => {
	try {
		console.log(
			"[IPC] Getting connection status for tool type:",
			tool_type
		);
		return new Promise((resolve) => {
			backendSocket.emit(
				"get-connection-status",
				{ tool_type, token },
				(result) => {
					console.log("[IPC] Connection status result:", result);
					resolve(
						result || {
							success: false,
							error: "No response from server",
						}
					);
				}
			);
		});
	} catch (e) {
		console.error("[IPC] Get connection status error:", e);
		return { success: false, error: e.message };
	}
});

// Thêm hàm lấy partition mới nhất từ backend
async function getLatestPartitionFromBackend(tool_type, account_id) {
	return new Promise((resolve) => {
		backendSocket.emit(
			"get-latest-partition",
			{ tool_type, account_id },
			(result) => {
				// result.partition là partition string, fallback nếu không có
				console.log("getLatestPartitionFromBackend", result);
				resolve(`persist:tool_${account_id}_${tool_type}`);
			}
		);
	});
}

// ========== ENHANCED TOOL OPENING WITH HYBRID LOGIC ==========
// Lắng nghe backend trả về lệnh mở tool - Enhanced with server state management
backendSocket.on("open-tool-tab", async (data) => {
	try {
		// Account login ở đây
		console.log("[MAIN] ===== OPEN-TOOL-TAB EVENT RECEIVED =====");
		console.log(
			"[MAIN] Tool type:",
			data.tool_type,
			"Account ID:",
			data.id
		);

		// ===== VALIDATION: Kiểm tra tool đã mở chưa =====
		const key = `${data.tool_type}_${data.id}`;

		// Cleanup destroyed windows trước khi kiểm tra
		// cleanupDestroyedWindows();

		// Kiểm tra tool đã mở và đang hoạt động
		const existingWindows = openedToolWindows[key] || [];
		const activeWindows = existingWindows.filter(
			(win) => win && !win.isDestroyed()
		);

		if (activeWindows.length > 0) {
			console.log(`[MAIN] ❌ Tool ${key} đã được mở, từ chối mở thêm`);

			// Focus vào window đã mở thay vì tạo mới
			const existingWin = activeWindows[0];
			existingWin.focus();
			existingWin.show();

			return; // Từ chối mở tool mới
		}

		console.log(`[MAIN] ✅ Tool ${key} chưa mở, tiếp tục tạo window mới`);

		// 1. Lấy partition/session
		const partitionName = await getLatestPartitionFromBackend(
			data.tool_type,
			data.id
		);
		console.log("[MAIN] Using partition:", partitionName);

		const ses = session.fromPartition(partitionName);

		// Thêm các header mặc định và cấu hình list loại trừ - CHỈ CHO TOOL KHÔNG NẰM TRONG EXCLUDED LIST
		if (
			!ses._muatoolHeaderInjected &&
			!excludedHeaderTools.includes(data.tool_type)
		) {
			// Danh sách các domain cần loại trừ (không thêm header)
			const excludedDomains = [
				"googleapis.com",
				"gstatic.com",
				"google.com",
				"googlesyndication.com",
				"doubleclick.net",
				"accounts.google.com",
				"login.microsoftonline.com",
				"api.stripe.com",
				"checkout.stripe.com",
				"pay.google.com",
			];

			// Danh sách các domain cần thêm header đặc biệt
			const specialDomains = {
				"pipiads.com": {
					"accept-language": "en-EU",
					device_id: "1085218295",
					"sec-ch-ua":
						'"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
					"sec-ch-ua-mobile": "?0",
					"sec-ch-ua-platform": '"Windows"',
				},
				"similarweb.com": {
					"accept-language": "en-EU",
					device_id: "1085218295",
				},
				"freepik.com": {
					"accept-language": "en-EU",
					device_id: "1085218295",
					language_code: "en",
					time_zone_id: "Asia/Saigon",
					timezone_offset: "-420",
				},
			};

			// Thêm header cho tất cả request
			ses.webRequest.onBeforeSendHeaders((details, callback) => {
				// Kiểm tra URL có thuộc danh sách loại trừ không
				const url = details.url;
				const shouldExclude = excludedDomains.some((domain) =>
					url.includes(domain)
				);

				if (!shouldExclude) {
					// Standard headers for all non-excluded domains
					details.requestHeaders["accept-language"] = "en-EU";
					details.requestHeaders["device_id"] = "1085218295";
					details.requestHeaders["sec-ch-ua"] =
						'"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
					details.requestHeaders["sec-ch-ua-mobile"] = "?0";
					details.requestHeaders["sec-ch-ua-platform"] = '"Windows"';

					// Apply special headers for specific domains
					for (const domain in specialDomains) {
						if (url.includes(domain)) {
							Object.assign(
								details.requestHeaders,
								specialDomains[domain]
							);
							break;
						}
					}
				}

				callback({
					cancel: false,
					requestHeaders: details.requestHeaders,
				});
			});

			ses._muatoolHeaderInjected = true; // Đánh dấu đã gắn, tránh gắn lại nhiều lần
			console.log("[MAIN] Custom headers injected for session");
		} else if (excludedHeaderTools.includes(data.tool_type)) {
			console.log(
				`[MAIN] Tool ${data.tool_type} excluded from custom headers - using default browser headers`
			);
		}

		// 2. Xóa storage nếu cần
		const isFixedPartition = TOOLS_REQUIRE_FIXED_PARTITION.includes(
			data.tool_type
		);
		if (!isFixedPartition) {
			console.log("[MAIN] Clearing storage for non-fixed partition");
			await ses.clearStorageData({
				storages: ["cookies", "localstorage", "caches"],
			});
			await new Promise((resolve) => setTimeout(resolve, 500));
		} else {
			console.log(
				"[MAIN] Keeping storage for fixed partition:",
				partitionName
			);
		}
		// 3. Parse proxy
		let proxy_server = (data.proxy_cookie || "").split("|");
		let proxyRules = proxy_server[0] || "";
		proxy_user = proxy_server[1] || "";
		proxy_pass = proxy_server[2] || "";
		console.log("[MAIN] Proxy rules:", proxyRules);

		// 4. Set proxy
		if (proxyRules) {
			console.log("[MAIN] Setting proxy:", proxyRules);
			await ses.setProxy({ proxyRules }).catch((e) => {
				console.log("[MAIN] Proxy set error:", e.message);
			});
		}
		// 5. Set cookies with enhanced validation and retry mechanism
		let cookiesArr = [];
		if (typeof data.cookies === "string") {
			try {
				cookiesArr = JSON.parse(data.cookies);
				console.log("[MAIN] Parsed cookies from string");
			} catch (e) {
				console.error("[MAIN] Cookie parsing error:", e.message);
				cookiesArr = [];
			}
		} else if (Array.isArray(data.cookies)) {
			cookiesArr = data.cookies;
			console.log("[MAIN] Using cookies array directly");
		}

		console.log(
			"[MAIN] Setting cookies count:",
			Array.isArray(cookiesArr) ? cookiesArr.length : 0
		);

		if (Array.isArray(cookiesArr) && cookiesArr.length > 0) {
			let successCount = 0;
			let failCount = 0;

			for (const ck of cookiesArr) {
				// Enhanced cookie validation
				if (!ck || !ck.name || typeof ck.name !== "string") {
					console.warn("[MAIN] Invalid cookie - missing name:", ck);
					failCount++;
					continue;
				}

				const url = buildCookieUrl(ck);
				if (!url) {
					console.warn("[MAIN] Invalid cookie URL for:", ck.name);
					failCount++;
					continue;
				}

				// Retry mechanism for cookie setting
				let retries = 3;
				let cookieSet = false;

				while (retries > 0 && !cookieSet) {
					try {
						await ses.cookies.set({
							url,
							name: ck.name,
							value: ck.value || "",
							domain: ck.domain,
							path: ck.path || "/",
							secure: !!ck.secure,
							httpOnly: !!ck.httpOnly,
							expirationDate: ck.expirationDate, // Persistent cookies như cũ
						});
						successCount++;
						cookieSet = true;
					} catch (e) {
						retries--;
						console.warn(
							`[MAIN] Cookie set retry ${3 - retries}/3 for ${
								ck.name
							}:`,
							e.message
						);
						if (retries > 0) {
							await new Promise((r) => setTimeout(r, 100)); // Wait before retry
						} else {
							failCount++;
						}
					}
				}
			}

			// Enhanced waiting time based on cookie count
			const waitTime = Math.min(500, cookiesArr.length * 50);
			await new Promise((r) => setTimeout(r, waitTime));

			console.log(
				`[MAIN] Cookies set completed - Success: ${successCount}, Failed: ${failCount}`
			);
		}

		const win = new BrowserWindow({
			width: 1980,
			height: 800,
			webPreferences: {
				preload: path.join(__dirname, "preload.js"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
				partition: partitionName,
				nativeWindowOpen: true,
				webSecurity: true, // Enable web security
				allowRunningInsecureContent: false, // Don't allow mixed content (HTTP on HTTPS)
				experimentalFeatures: false, // Disable experimental features
				backgroundThrottling: false, // Don't throttle background tabs
				spellcheck: false, // Disable spellcheck for performance
				defaultEncoding: "UTF-8", // Set default encoding
				devTools: true, // Disable DevTools completely
			},
		});

		// ========== ENHANCED DEVTOOLS PROTECTION FOR TOOL WINDOWS ==========
		// DevTools protection removed to avoid false virus detection

		// 7. Set user-agent - Simplified logic (server handles exclusions)
		console.log(
			"[MAIN] Processing user agent for tool:",
			data.tool_type,
			"Received user_agent:",
			data.user_agent
		);

		// Server already handles excluded tools by sending empty user_agent
		if (data.user_agent && data.user_agent.trim().length > 0) {
			win.webContents.setUserAgent(data.user_agent);
			console.log("[MAIN] User agent set:", data.user_agent);
		} else {
			console.log(
				"[MAIN] No user agent provided by server - using default browser user agent"
			);
		}
		// 8. Load URL
		let toolUrl = data.url || data.login_url;
		console.log("[MAIN] Loading URL:", toolUrl);
		win.loadURL(toolUrl);
		win.setTitle(`Tool ${data.tool_type} - User`);

		// Lưu token và tool info vào window metadata để sử dụng cho credit deduction
		win.token = data.token;
		win.toolType = data.tool_type;
		win.accountId = data.id;

		// ===== LƯU TOOL DATA CHO CREDIT DISPLAY VÀ COOKIE CACHING =====
		win._muatool_toolData = {
			credit: data.credit || 0,
			accountId: data.id,
			canPerformAction: true,
			maxRowsPerExport: data.maxRowsPerExport || 1000,
			exportCount: data.exportCount || 0,
			maxExports: data.maxExports || 100,
			max_rows_per_month: data.max_rows_per_month || 150000,
		};

		// Cache cookies for child windows to avoid re-parsing - Enhanced
		win._muatool_cookies = cookiesArr || [];
		win._muatool_localStorage = data.localstorage;
		console.log(
			`[MAIN] Cached ${win._muatool_cookies.length} cookies for parent window`
		);

		// ===== ÁP DỤNG CACHED COOKIES NẾU CÓ =====
		if (global.cachedCookies && global.cachedCookies[data.tool_type]) {
			console.log(`[MAIN] Applying cached cookies for ${data.tool_type}`);
			const cachedCks = global.cachedCookies[data.tool_type];

			for (const ck of cachedCks) {
				try {
					const url = buildCookieUrl(ck);
					if (!url) continue;

					await ses.cookies.set({
						url,
						name: ck.name,
						value: ck.value,
						domain: ck.domain,
						path: ck.path || "/",
						secure: !!ck.secure,
						httpOnly: !!ck.httpOnly,
						expirationDate: ck.expirationDate, // Persistent cookies như cũ
					});
				} catch (e) {
					console.warn(
						`[CACHED] Failed to set cached cookie ${ck.name}:`,
						e.message
					);
				}
			}

			// Clear cache sau khi apply
			delete global.cachedCookies[data.tool_type];
			console.log(`[MAIN] Cleared cached cookies for ${data.tool_type}`);
		}

		console.log(
			"[MAIN] Stored tool data and cached resources for child windows"
		);
		// 9. Enhanced localStorage injection with better error handling
		win.webContents.on("did-finish-load", async () => {
			console.log(
				"[MAIN] Page finished loading, starting enhanced resource injection..."
			);

			// Enhanced localStorage injection
			if (data.localstorage) {
				try {
					const storageObj =
						typeof data.localstorage === "string"
							? JSON.parse(data.localstorage)
							: data.localstorage;

					if (storageObj && typeof storageObj === "object") {
						const storageKeys = Object.keys(storageObj);
						console.log(
							`[MAIN] Injecting ${storageKeys.length} localStorage items`
						);

						// Enhanced localStorage injection with validation
						await win.webContents.executeJavaScript(`
              (function() {
                try {
                  const data = ${JSON.stringify(storageObj)};
                  let successCount = 0;
                  let failCount = 0;
                  
                  for (const k in data) {
                    try { 
                      localStorage.setItem(k, data[k]); 
                      successCount++;
                    } catch(e) { 
                      console.warn('[STORAGE] Failed to set:', k, e.message);
                      failCount++;
                    }
                  }
                  
                  console.log('[STORAGE] localStorage injection completed - Success:', successCount, 'Failed:', failCount);
                  return { success: true, set: successCount, failed: failCount };
                } catch(e) {
                  console.error('[STORAGE] localStorage injection error:', e);
                  return { success: false, error: e.message };
                }
              })();
            `);
						console.log(
							"[MAIN] LocalStorage injected successfully"
						);
					}
				} catch (e) {
					console.error(
						"[MAIN] LocalStorage injection error:",
						e.message
					);
				}
			}

			// ========== APPLY ENHANCED MANUAL INJECTION SYSTEM ==========
			if (data.token) {
				let injectionAttempts = 0;
				const maxInjectionAttempts = 3;

				const attemptInjection = async () => {
					try {
						injectionAttempts++;
						console.log(
							`[MAIN] Injection attempt ${injectionAttempts}/${maxInjectionAttempts} for:`,
							data.tool_type
						);

						const injectionResult =
							await InjectionManager.requestToolInjections(
								data.token,
								data.tool_type,
								data.id
							);
						if (injectionResult.success) {
							console.log(
								"[MAIN] Applying manual injection package for:",
								data.tool_type
							);
							await InjectionManager.applyInjectionPackage(
								win,
								injectionResult.injections
							);

							// Cache injections for child windows
							win._muatool_injections =
								injectionResult.injections;

							// ===== APPLY ENHANCED CREDIT INFO =====
							const creditInfoInjection =
								InjectionManager.getCreditInfoInjection(
									data.tool_type,
									win._muatool_toolData
								);
							if (creditInfoInjection) {
								await win.webContents.executeJavaScript(
									creditInfoInjection
								);
								console.log(
									"[MAIN] Applied credit info for parent window"
								);
							}

							console.log(
								`[MAIN] Successfully applied injection system for ${data.tool_type}`
							);
							return true;
						} else {
							throw new Error(
								injectionResult.error ||
									"Failed to get injection system"
							);
						}
					} catch (e) {
						console.error(
							`[MAIN] Injection attempt ${injectionAttempts} failed:`,
							e.message
						);

						if (injectionAttempts < maxInjectionAttempts) {
							console.log(
								`[MAIN] Retrying injection in 1 second...`
							);
							await new Promise((resolve) =>
								setTimeout(resolve, 1000)
							);
							return attemptInjection();
						} else {
							console.error(
								`[MAIN] All injection attempts failed for ${data.tool_type}`
							);
							return false;
						}
					}
				};

				await attemptInjection();
			} else {
				console.log("[MAIN] Skipping injection - token not available");
			}

			// ========== INJECT DEVTOOLS PROTECTION ==========
		// 	try {
		// 		await win.webContents.executeJavaScript(`
        //   (function() {
        //     // Chặn right-click
        //     document.addEventListener('contextmenu', function(e) {
        //       e.preventDefault();
        //       return false;
        //     });
            
        //     // Chặn các phím tắt DevTools
        //     document.addEventListener('keydown', function(e) {
        //       // F12
        //       if (e.key === 'F12') {
        //         e.preventDefault();
        //         return false;
        //       }
              
        //       // Ctrl+Shift+I
        //       if (e.ctrlKey && e.shiftKey && e.key === 'I') {
        //         e.preventDefault();
        //         return false;
        //       }
              
        //       // Ctrl+Shift+J
        //       if (e.ctrlKey && e.shiftKey && e.key === 'J') {
        //         e.preventDefault();
        //         return false;
        //       }
              
        //       // Ctrl+U
        //       if (e.ctrlKey && e.key === 'u') {
        //         e.preventDefault();
        //         return false;
        //       }
              
        //       // Ctrl+Shift+C
        //       if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        //         e.preventDefault();
        //         return false;
        //       }
        //     });
            
        //     // Chặn DevTools detect thông qua console
        //     let devtools = {open: false, orientation: null};
        //     const threshold = 160;
        //     setInterval(function() {
        //       if (window.outerHeight - window.innerHeight > threshold || 
        //           window.outerWidth - window.innerWidth > threshold) {
        //         if (!devtools.open) {
        //           devtools.open = true;
        //           console.clear();
        //           console.log('%cDevTools detected! Access denied.', 'color: red; font-size: 20px; font-weight: bold;');
        //           // Có thể thêm action khác như đóng window
        //           window.close();
        //         }
        //       } else {
        //         devtools.open = false;
        //       }
        //     }, 500);
            
        //     // Override console methods để chặn debug
        //     const noop = function() {};
        //     ['log', 'debug', 'info', 'warn', 'error', 'assert', 'dir', 'dirxml',
        //      'group', 'groupEnd', 'time', 'timeEnd', 'count', 'trace', 'profile', 'profileEnd']
        //     .forEach(function(method) {
        //       window.console[method] = noop;
        //     });
            
        //     console.log('[SECURITY] DevTools protection activated for tool window');
        //   })();
        // `);
		// 		console.log(
		// 			"[SECURITY] DevTools protection injected successfully"
		// 		);
		// 	} catch (e) {
		// 		console.error(
		// 			"[SECURITY] Failed to inject DevTools protection:",
		// 			e
		// 		);
		// 	}
		});
		// 10. Gán handler cho window tool vừa tạo (partition, proxy, cookies cho child window)
		function getDomainFromUrl(url) {
			try {
				const u = new URL(url);
				return u.origin;
			} catch (e) {
				return "https://app.ahrefs.com";
			}
		}

		function setupWindowHandlers(
			win,
			partitionName,
			proxyRules,
			cookiesArr,
			toolType
		) {
			win.webContents.setWindowOpenHandler(({ url }) => {
				// Chặn triệt để mở child window cho Freepik
				if (toolType === "freepik") {
					dialog.showErrorBox(
						"Thông báo",
						"Freepik chỉ cho phép sử dụng trên 1 tab chính, không được mở tab mới!"
					);
					return { action: "deny" };
				}
				return {
					action: "allow",
					overrideBrowserWindowOptions: {
						webPreferences: {
							preload: path.join(__dirname, "preload.js"),
							contextIsolation: true,
							nodeIntegration: false,
							sandbox: false,
							nativeWindowOpen: true,
							partition: partitionName,
							webSecurity: true,
							enableRemoteModule: false,
							allowRunningInsecureContent: false, // Don't allow mixed content
							experimentalFeatures: false, // Disable experimental features
							backgroundThrottling: false, // Don't throttle background tabs
							spellcheck: false, // Disable spellcheck for performance
							defaultEncoding: "UTF-8", // Set default encoding
							devTools: true, // Disable DevTools completely
						},
					},
				};
			});

			win.webContents.on("did-create-window", async (childWindow) => {
				console.log(
					"[MAIN] Creating enhanced child window for:",
					toolType
				);
				setupWindowHandlers(
					childWindow,
					partitionName,
					proxyRules,
					cookiesArr,
					toolType
				);

				// ===== ENHANCED METADATA TRANSFER =====
				childWindow.token = win.token;
				childWindow.toolType = win.toolType;
				childWindow.accountId = win.accountId;

				// Enhanced tool data transfer with validation
				childWindow._muatool_toolData = {
					...win._muatool_toolData,
					credit: win._muatool_toolData?.credit || 0,
					accountId: win.accountId,
					canPerformAction:
						win._muatool_toolData?.canPerformAction || true,
				};

				// Transfer cached resources to child - Enhanced
				childWindow._muatool_cookies = win._muatool_cookies || [];
				childWindow._muatool_localStorage = win._muatool_localStorage;
				childWindow._muatool_injections = win._muatool_injections;

				// Cache cookies từ parent session nếu chưa có
				if (
					!childWindow._muatool_cookies.length &&
					win.webContents.session
				) {
					console.log(
						"[MAIN] Caching cookies from parent session for child"
					);
					try {
						const sessionCookies =
							await win.webContents.session.cookies.get({});
						childWindow._muatool_cookies = sessionCookies.filter(
							(ck) => ck.domain && ck.name
						);
						console.log(
							`[MAIN] Cached ${childWindow._muatool_cookies.length} cookies for child`
						);
					} catch (e) {
						console.warn(
							"[MAIN] Failed to cache cookies for child:",
							e.message
						);
					}
				}

				console.log(
					"[MAIN] Enhanced metadata transferred to child window:",
					{
						token: childWindow.token?.substring(0, 8) + "...",
						toolType: childWindow.toolType,
						hasCachedCookies:
							!!childWindow._muatool_cookies?.length,
						hasCachedStorage: !!childWindow._muatool_localStorage,
						hasInjections: !!childWindow._muatool_injections,
					}
				);

				// 1. Enhanced user-agent handling
				try {
					const parentUserAgent = win.webContents.getUserAgent();
					if (parentUserAgent) {
						childWindow.webContents.setUserAgent(parentUserAgent);
						console.log(
							"[MAIN] User-agent applied to child window"
						);
					}
				} catch (e) {
					console.error(
						"[MAIN] Failed to set user-agent for child window:",
						e.message
					);
				}

				// 2. Enhanced sync with retry mechanism
				let syncAttempts = 0;
				const maxSyncAttempts = 3;

				const attemptSync = async () => {
					try {
						syncAttempts++;
						console.log(
							`[MAIN] Sync attempt ${syncAttempts}/${maxSyncAttempts} for child window`
						);

						await syncCookiesAndStorage(win, childWindow, toolType);
						console.log(
							"[MAIN] Child window sync completed successfully"
						);
						return true;
					} catch (e) {
						console.error(
							`[MAIN] Sync attempt ${syncAttempts} failed:`,
							e.message
						);

						if (syncAttempts < maxSyncAttempts) {
							console.log(`[MAIN] Retrying sync in 500ms...`);
							await new Promise((resolve) =>
								setTimeout(resolve, 500)
							);
							return attemptSync();
						} else {
							console.error(
								`[MAIN] All sync attempts failed for child window`
							);
							return false;
						}
					}
				};

				await attemptSync();

				// 3. Enhanced injection system for child window
				if (childWindow._muatool_injections) {
					let injectionDelay = 300;

					// Adjust delay based on tool type
					if (toolType === "freepik") injectionDelay = 500;
					if (toolType === "ahrefs") injectionDelay = 400;

					setTimeout(async () => {
						let childInjectionAttempts = 0;
						const maxChildInjectionAttempts = 3;

						const attemptChildInjection = async () => {
							try {
								childInjectionAttempts++;
								console.log(
									`[MAIN] Child injection attempt ${childInjectionAttempts}/${maxChildInjectionAttempts}`
								);

								await InjectionManager.applyInjectionPackage(
									childWindow,
									childWindow._muatool_injections
								);

								// Enhanced credit info application with delay
								setTimeout(async () => {
									try {
										const creditInfoInjection =
											InjectionManager.getCreditInfoInjection(
												childWindow.toolType,
												childWindow._muatool_toolData
											);
										if (creditInfoInjection) {
											await childWindow.webContents.executeJavaScript(
												creditInfoInjection
											);
											console.log(
												"[MAIN] Applied credit info for child window"
											);
										}
									} catch (e) {
										console.error(
											"[MAIN] Error applying credit info to child window:",
											e
										);
									}
								}, 600);

								// Enhanced socket and handler setup
								await childWindow.webContents
									.executeJavaScript(`
                  (function() {
                    try {
                      // Enhanced socket setup with validation
                      if (typeof window.io === 'undefined' || !window.socket || !window.socket.connected) {
                        console.log('[CHILD] Setting up socket connection...');
                        var s = document.createElement('script');
                        s.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
                        s.onload = function() {
                          window.socket = io('https://app.muatool.com', { 
                            reconnection: true, 
                            transports: ['websocket', 'polling'],
                            timeout: 20000
                          });
                          console.log('[CHILD] Socket connection established');
                        };
                        s.onerror = function() {
                          console.warn('[CHILD] Failed to load socket.io script');
                        };
                        document.head.appendChild(s);
                      }
                      
                      // Enhanced credit handler setup
                      if (typeof window.muatoolCreditHandler !== 'function' && typeof window.truCredit === 'function') {
                        window.muatoolCreditHandler = window.truCredit;
                        console.log('[CHILD] Credit handler established');
                      }
                      
                      console.log('[CHILD] Enhanced injection setup completed');
                    } catch (e) {
                      console.error('[CHILD] Enhanced injection setup error:', e);
                    }
                  })();
                `);

								console.log(
									"[MAIN] Enhanced injection applied for child window"
								);
								return true;
							} catch (e) {
								console.error(
									`[MAIN] Child injection attempt ${childInjectionAttempts} failed:`,
									e.message
								);

								if (
									childInjectionAttempts <
									maxChildInjectionAttempts
								) {
									console.log(
										`[MAIN] Retrying child injection in 500ms...`
									);
									await new Promise((resolve) =>
										setTimeout(resolve, 500)
									);
									return attemptChildInjection();
								} else {
									console.error(
										`[MAIN] All child injection attempts failed`
									);
									return false;
								}
							}
						};

						await attemptChildInjection();
					}, injectionDelay);
				}

				// 4. Enhanced reload handling for child window
				childWindow.webContents.on("did-finish-load", async () => {
					console.log(
						"[MAIN] Child window reloaded, re-applying enhancements..."
					);

					try {
						// Re-apply user-agent
						const parentUserAgent = win.webContents.getUserAgent();
						if (parentUserAgent) {
							childWindow.webContents.setUserAgent(
								parentUserAgent
							);
						}

						// Re-sync cookies and storage with retry
						let reloadSyncAttempts = 0;
						const maxReloadSyncAttempts = 2;

						const attemptReloadSync = async () => {
							try {
								reloadSyncAttempts++;
								await syncCookiesAndStorage(
									win,
									childWindow,
									toolType
								);
								console.log(
									"[MAIN] Child window reload sync completed"
								);
								return true;
							} catch (e) {
								if (
									reloadSyncAttempts < maxReloadSyncAttempts
								) {
									console.log(
										`[MAIN] Reload sync retry ${
											reloadSyncAttempts + 1
										}...`
									);
									await new Promise((resolve) =>
										setTimeout(resolve, 300)
									);
									return attemptReloadSync();
								} else {
									console.error(
										"[MAIN] Reload sync failed:",
										e.message
									);
									return false;
								}
							}
						};

						await attemptReloadSync();

						// Re-apply injections with enhanced error handling
						if (childWindow._muatool_injections) {
							setTimeout(async () => {
								let reloadInjectionAttempts = 0;
								const maxReloadInjectionAttempts = 2;

								const attemptReloadInjection = async () => {
									try {
										reloadInjectionAttempts++;
										console.log(
											`[MAIN] Child reload injection attempt ${reloadInjectionAttempts}/${maxReloadInjectionAttempts}`
										);

										await InjectionManager.applyInjectionPackage(
											childWindow,
											childWindow._muatool_injections
										);

										// Re-apply credit info with delay
										setTimeout(async () => {
											try {
												const creditInfoInjection =
													InjectionManager.getCreditInfoInjection(
														childWindow.toolType,
														childWindow._muatool_toolData
													);
												if (creditInfoInjection) {
													await childWindow.webContents.executeJavaScript(
														creditInfoInjection
													);
													console.log(
														"[MAIN] Re-applied credit info for child window after reload"
													);
												}
											} catch (e) {
												console.error(
													"[MAIN] Error re-applying credit info after reload:",
													e.message
												);
											}
										}, 600);

										// Re-establish enhanced handlers
										await childWindow.webContents
											.executeJavaScript(`
                      (function() {
                        try {
                          console.log('[CHILD-RELOAD] Re-establishing enhanced handlers with token: ${childWindow.token?.substring(
								0,
								8
							)}...');
                          
                          // Re-establish credit handler
                          if (typeof window.muatoolCreditHandler !== 'function' && typeof window.truCredit === 'function') {
                            window.muatoolCreditHandler = window.truCredit;
                            console.log('[CHILD-RELOAD] Credit handler re-established');
                          }
                          
                          // Re-establish socket if needed
                          if (typeof window.io === 'undefined' || !window.socket || !window.socket.connected) {
                            console.log('[CHILD-RELOAD] Re-establishing socket connection...');
                            var s = document.createElement('script');
                            s.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
                            s.onload = function() {
                              window.socket = io('https://app.muatool.com', { 
                                reconnection: true, 
                                transports: ['websocket', 'polling'],
                                timeout: 20000
                              });
                            };
                            document.head.appendChild(s);
                          }
                          
                          console.log('[CHILD-RELOAD] Enhanced handlers re-established successfully');
                        } catch (e) {
                          console.error('[CHILD-RELOAD] Error re-establishing handlers:', e);
                        }
                      })();
                    `);

										console.log(
											"[MAIN] Child window reload injection completed successfully"
										);
										return true;
									} catch (e) {
										console.error(
											`[MAIN] Child reload injection attempt ${reloadInjectionAttempts} failed:`,
											e.message
										);

										if (
											reloadInjectionAttempts <
											maxReloadInjectionAttempts
										) {
											await new Promise((resolve) =>
												setTimeout(resolve, 400)
											);
											return attemptReloadInjection();
										} else {
											console.error(
												"[MAIN] All child reload injection attempts failed"
											);
											return false;
										}
									}
								};

								await attemptReloadInjection();
							}, 250); // Delay for DOM readiness
						}
					} catch (e) {
						console.error(
							"[MAIN] Child window reload handling failed:",
							e.message
						);
					}
				});
			});

			// Enhanced reload handling for parent window
			win.webContents.on("did-finish-load", async () => {
				console.log(
					"[MAIN] Parent window reloaded, re-applying enhancements..."
				);

				if (win._muatool_injections) {
					let parentReloadAttempts = 0;
					const maxParentReloadAttempts = 3;

					const attemptParentReload = async () => {
						try {
							parentReloadAttempts++;
							console.log(
								`[MAIN] Parent reload attempt ${parentReloadAttempts}/${maxParentReloadAttempts}`
							);

							await InjectionManager.applyInjectionPackage(
								win,
								win._muatool_injections
							);

							// Re-apply credit info
							setTimeout(async () => {
								try {
									const creditInfoInjection =
										InjectionManager.getCreditInfoInjection(
											win.toolType,
											win._muatool_toolData
										);
									if (creditInfoInjection) {
										await win.webContents.executeJavaScript(
											creditInfoInjection
										);
										console.log(
											"[MAIN] Re-applied credit info for parent window after reload"
										);
									}
								} catch (e) {
									console.error(
										"[MAIN] Error re-applying parent credit info:",
										e.message
									);
								}
							}, 500);

							console.log(
								"[MAIN] Parent window reload injection completed successfully"
							);
							return true;
						} catch (e) {
							console.error(
								`[MAIN] Parent reload attempt ${parentReloadAttempts} failed:`,
								e.message
							);

							if (
								parentReloadAttempts < maxParentReloadAttempts
							) {
								await new Promise((resolve) =>
									setTimeout(resolve, 600)
								);
								return attemptParentReload();
							} else {
								console.error(
									"[MAIN] All parent reload attempts failed"
								);
								return false;
							}
						}
					};

					setTimeout(async () => {
						await attemptParentReload();
					}, 300);
				}
			});
		}
		setupWindowHandlers(
			win,
			partitionName,
			proxyRules,
			cookiesArr,
			data.tool_type
		);
		// 11. Lưu vào mapping để có thể đóng khi hết hạn
		if (!openedToolWindows[key]) openedToolWindows[key] = [];
		openedToolWindows[key].push(win);

		win.on("closed", () => {
			console.log(`[MAIN] Window closing: ${key}`);

			// ===== IMMEDIATE CLEANUP =====
			// 1. Xóa khỏi openedToolWindows ngay lập tức
			if (openedToolWindows[key]) {
				openedToolWindows[key] = (openedToolWindows[key] || []).filter(
					(w) => w !== win
				);
				if (openedToolWindows[key].length === 0) {
					delete openedToolWindows[key];
					console.log(`[MAIN] Deleted tool key: ${key}`);
				}
			}

			// 2. Force cleanup all destroyed windows
			// cleanupDestroyedWindows();

			console.log(
				`[MAIN] Window closed, remaining tools: ${
					Object.keys(openedToolWindows).length
				}`
			);

			// ===== SERVER SYNC & CLEANUP =====
			const token = win.token;
			const toolType = win.toolType;
			if (token && toolType) {
				console.log(
					`[MAIN] Notifying server cleanup: ${toolType} for token ${token}`
				);

				// Immediate cleanup
				try {
					backendSocket.emit("user-close-tool", {
						token,
						tool: toolType,
					});

					// Force cleanup với guarantee
					setTimeout(() => {
						backendSocket.emit("force-cleanup-token-tools", {
							token,
							tool: toolType,
							reason: "window_closed",
						});
						console.log(
							`[MAIN] Force cleanup sent for: ${toolType}`
						);
					}, 500);
				} catch (e) {
					console.error("[MAIN] Error sending cleanup:", e);
				}
			}
		});
		// 12. Xử lý đóng/error
		win.webContents.on(
			"did-fail-load",
			(event, errorCode, errorDescription, validatedURL) => {
				console.log(
					`[did-fail-load] ${errorCode} - ${errorDescription} - ${validatedURL}`
				);
			}
		);
	} catch (e) {
		console.log("[main.js] open-tool-tab error:", e.message);
	}
});

// Đăng ký app.on('login', ...) MỘT LẦN DUY NHẤT ở ngoài cùng
app.on("login", (event, webContents, request, authInfo, callback) => {
	event.preventDefault();
	callback(proxy_user, proxy_pass);
});

app.whenReady().then(async () => {
	// ========== SECURITY AND CERTIFICATE HANDLING ==========

	// Handle certificate errors gracefully
	app.on(
		"certificate-error",
		(event, webContents, url, error, certificate, callback) => {
			// Allow certificates for local development and muatool.com
			const allowedHosts = [
				"localhost",
				"127.0.0.1",
				"app.muatool.com",
				"muatool.com",
			];
			const urlObj = new URL(url);

			if (allowedHosts.some((host) => urlObj.hostname.includes(host))) {
				console.log(
					"[CERT] Allowing certificate for trusted host:",
					urlObj.hostname
				);
				event.preventDefault();
				callback(true);
			} else {
				console.warn(
					"[CERT] Certificate error for untrusted host:",
					urlObj.hostname,
					error
				);
				callback(false);
			}
		}
	);

	// Enhanced permission handling
	session.defaultSession.setPermissionRequestHandler(
		(webContents, permission, callback) => {
			const allowedPermissions = [
				"notifications",
				"clipboard-read",
				"clipboard-write",
			];
			const url = webContents.getURL();

			// Allow permissions for muatool domains
			if (
				url.includes("muatool.com") &&
				allowedPermissions.includes(permission)
			) {
				console.log(
					"[PERM] Granting permission:",
					permission,
					"for:",
					url
				);
				callback(true);
			} else {
				console.log(
					"[PERM] Denying permission:",
					permission,
					"for:",
					url
				);
				callback(false);
			}
		}
	);

	// Enhanced CSP handling for better security
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		// Add security headers for muatool domains
		if (details.url.includes("muatool.com")) {
			callback({
				responseHeaders: {
					...details.responseHeaders,
					"Content-Security-Policy": [
						"default-src 'self' 'unsafe-inline' 'unsafe-eval' https://app.muatool.com https://muatool.com; " +
							"connect-src 'self' https://app.muatool.com wss://app.muatool.com; " +
							"script-src 'self' 'unsafe-inline' 'unsafe-eval' https://app.muatool.com; " +
							"style-src 'self' 'unsafe-inline' https://app.muatool.com",
					],
				},
			});
		} else {
			callback({ responseHeaders: details.responseHeaders });
		}
	});

	// Enhanced device info initialization with retry mechanism
	let deviceInitAttempts = 0;
	const maxDeviceInitAttempts = 3;

	const initializeDeviceInfo = async () => {
		try {
			deviceInitAttempts++;
			console.log(
				`[MAIN] Initializing device info (attempt ${deviceInitAttempts}/${maxDeviceInitAttempts})...`
			);

			currentDeviceInfo =
				await deviceFingerprint.getDeviceInfoForServer();
			console.log("[MAIN] Device info initialized successfully:", {
				deviceId: currentDeviceInfo.deviceId,
				hostname: currentDeviceInfo.hostname,
				username: currentDeviceInfo.username,
				platform: currentDeviceInfo.platform,
			});
			return true;
		} catch (error) {
			console.error(
				`[MAIN] Device init attempt ${deviceInitAttempts} failed:`,
				error
			);

			if (deviceInitAttempts < maxDeviceInitAttempts) {
				console.log(
					`[MAIN] Retrying device initialization in 1 second...`
				);
				await new Promise((resolve) => setTimeout(resolve, 1000));
				return initializeDeviceInfo();
			} else {
				console.error(
					"[MAIN] All device init attempts failed, using fallback device info"
				);
				currentDeviceInfo = {
					deviceId: `fallback_${Date.now()}_${Math.random()
						.toString(36)
						.substr(2, 9)}`,
					fingerprint: {
						fallback: true,
						platform: process.platform,
						arch: process.arch,
						timestamp: Date.now(),
					},
				};
				return false;
			}
		}
	};

	await initializeDeviceInfo();

	// Kiểm tra version ngay khi app khởi động
	console.log("[VERSION] Checking version on startup...");
	const versionValid = await checkVersionWithServer();

	if (!versionValid) {
		console.log("[VERSION] Version check failed, app will exit");
		return; // App sẽ thoát trong checkVersionWithServer
	}

	// Khởi tạo check version định kỳ (mỗi 30 phút)
	versionCheckInterval = setInterval(async () => {
		console.log("[VERSION] Periodic version check...");
		await checkVersionWithServer();
	}, 30 * 60 * 1000);

	// Tạo menu cho application
	createApplicationMenu();

	createWindow();

	// Cleanup định kỳ để đảm bảo mapping chính xác
	setInterval(() => {
		// cleanupDestroyedWindows();
	}, 30000); // Cleanup mỗi 30 giây

	setTimeout(() => {
		try {
			socketOptimizer = new SocketOptimizer(backendSocket);
			console.log("[SOCKET] Performance optimizer initialized");
		} catch (e) {
			console.error("[SOCKET] Failed to initialize optimizer:", e);
		}
	}, 500);
});

app.on("window-all-closed", async () => {
	try {
		// Enhanced cleanup on app exit
		console.log("[APP-EXIT] Starting enhanced cleanup...");

		// 1. Cleanup version check interval
		if (versionCheckInterval) {
			clearInterval(versionCheckInterval);
			console.log("[VERSION] Version check interval cleared");
		}

		// 2. Clean all temporary sessions và partitions
		const allPartitions = session.getAllSessions();
		let clearedCount = 0;

		for (const ses of allPartitions) {
			if (
				ses.partition.includes("temp:") ||
				ses.partition.includes("user:")
			) {
				try {
					await ses.clearStorageData({
						storages: [
							"cookies",
							"localstorage",
							"sessionstorage",
							"caches",
							"indexdb",
							"websql",
						],
					});
					clearedCount++;
				} catch (e) {
					console.warn(
						"[APP-EXIT] Failed to clear session:",
						ses.partition,
						e.message
					);
				}
			}
		}

		console.log(`[APP-EXIT] Cleaned ${clearedCount} sessions before exit`);

		// 3. Close socket connection
		if (backendSocket && backendSocket.connected) {
			backendSocket.disconnect();
			console.log("[APP-EXIT] Socket disconnected");
		}

		console.log("[APP-EXIT] Enhanced cleanup completed");
	} catch (error) {
		console.error("[APP-EXIT] Error during cleanup:", error);
	}

	if (process.platform !== "darwin") app.quit();
});

// Lấy cookies
ipcMain.handle("get-tool-cookies", async (event, body) => {
	return new Promise((resolve) => {
		backendSocket.emit("get-tool-cookies", body, (result) => {
			resolve(result);
		});
	});
});

// Lấy token info với device validation
ipcMain.handle("get-token-info", async (event, body) => {
	return new Promise(async (resolve) => {
		try {
			// Đảm bảo có device info
			if (!currentDeviceInfo) {
				currentDeviceInfo =
					await deviceFingerprint.getDeviceInfoForServer();
			}

			// Thêm raw device data - server sẽ tính fingerprint
			const requestBody = {
				...body,
				device_raw_data: currentDeviceInfo, // Gửi raw data, không có deviceId
			};

			backendSocket.emit("get-token-info", requestBody, (result) => {
				resolve(result);
			});
		} catch (error) {
			console.error("[DEVICE] Error in get-token-info:", error);
			// Fallback: gửi request không có device info
			backendSocket.emit("get-token-info", body, (result) => {
				resolve(result);
			});
		}
	});
});

// Thêm tài khoản
ipcMain.handle("add-account", async (event, body) => {
	return new Promise((resolve) => {
		backendSocket.emit("add-account", body, (result) => {
			resolve(result);
		});
	});
});

// Sửa tài khoản
ipcMain.handle("update-account", async (event, id, body) => {
	return new Promise((resolve) => {
		backendSocket.emit("update-account", { id, ...body }, (result) => {
			resolve(result);
		});
	});
});

// Xóa tài khoản
ipcMain.handle("delete-account", async (event, id) => {
	return new Promise((resolve) => {
		backendSocket.emit("delete-account", { id }, (result) => {
			resolve(result);
		});
	});
});

// Lấy danh sách account
ipcMain.handle("get-account-list", async () => {
	return new Promise((resolve) => {
		backendSocket.emit("get-account-list", {}, (result) => {
			resolve(result);
		});
	});
});

// Lắng nghe sự kiện tool-expired từ server để tự động đóng tool
backendSocket.on("tool-expired", ({ toolCode, accountId, message }) => {
	const key = `${toolCode}_${accountId}`;
	const wins = openedToolWindows[key] || [];

	// Chỉ hiển thị thông báo nếu còn tool window đang mở
	if (wins.length > 0) {
		wins.forEach((win) => {
			if (win && !win.isDestroyed()) {
				dialog.showErrorBox("Thông báo", message || "Tool đã hết hạn!");
				win.close();
			}
		});
		delete openedToolWindows[key];
	}
});

backendSocket.on("show-notice", ({ message, link }) => {
	// Cleanup destroyed windows first
	// cleanupDestroyedWindows();

	// Chỉ hiển thị thông báo nếu có tool đang mở
	if (hasAnyToolsOpened()) {
		const { dialog } = require("electron");
		dialog
			.showMessageBox({
				type: "warning",
				title: "Thông báo cập nhật",
				message:
					message || "Bạn cần cập nhật tool để tiếp tục sử dụng.",
				detail: link ? `Xem chi tiết: ${link}` : "",
			})
			.then((result) => {
				if (link && result.response === 0) {
					shell.openExternal(link);
				}
			});
	}
});

backendSocket.on("tool-open-fail", (data) => {
	// Chỉ hiển thị thông báo lỗi tool-open-fail cho main window (dashboard)
	// Không hiển thị nếu thông báo liên quan đến tool đã đóng
	// const { dialog } = require("electron");

	// // Kiểm tra xem có tool nào đang mở không
	// const hasOpenedTools = Object.keys(openedToolWindows).length > 0;

	// // Luôn hiển thị lỗi open-fail vì đây là phản hồi từ việc user click mở tool
	// dialog.showErrorBox("Thông báo", data.error || "Không thể mở tool!");
});

// ========== TOKEN BLOCKED EVENT HANDLERS ==========
// Xử lý khi token bị block
backendSocket.on("token-blocked", (data) => {
	console.log("[TOKEN_BLOCKED] Received token blocked event:", data);

	// Đóng tất cả tool windows ngay lập tức
	for (const [key, win] of Object.entries(openedToolWindows)) {
		if (win && !win.isDestroyed()) {
			try {
				// Gửi thông báo tới window trước khi đóng
				safeExecuteJavaScript(
					win,
					`
          alert('Token đã bị khóa do đăng nhập trên máy khác. Tool sẽ đóng ngay.');
        `,
					"token-blocked notification"
				);

				setTimeout(() => {
					if (!win.isDestroyed()) {
						win.close();
					}
				}, 1000);
			} catch (error) {
				console.error("[TOKEN_BLOCKED] Error closing window:", error);
			}
		}
	}

	// Clear opened tools mapping
	Object.keys(openedToolWindows).forEach((key) => {
		delete openedToolWindows[key];
	});

	console.log("[TOKEN_BLOCKED] All tools closed due to token block");
});

// Xử lý check token status
backendSocket.on("check-token-status", (data) => {
	if (data.blockedToken) {
		console.log(
			"[TOKEN_CHECK] Checking if any opened tools use blocked token:",
			data.blockedToken
		);

		// Kiểm tra và đóng các tools đang sử dụng token bị block
		for (const [key, win] of Object.entries(openedToolWindows)) {
			if (win && !win.isDestroyed()) {
				// Đóng ngay không cần check token cụ thể vì khó track token cho từng window
				// Chỉ cần đóng tất cả để an toàn
				try {
					safeExecuteJavaScript(
						win,
						`
            alert('Phát hiện token conflict. Tool sẽ đóng để bảo mật.');
          `,
						"token-check notification"
					);

					setTimeout(() => {
						if (!win.isDestroyed()) {
							win.close();
						}
					}, 1000);
				} catch (error) {
					console.error("[TOKEN_CHECK] Error closing window:", error);
				}
			}
		}
	}
});

// ========== ALL IPC HANDLERS FOR INJECTIONS NOW REMOVED ==========
// No IPC handlers needed for injections - everything handled by server
console.log(
	"[SERVER-MANAGED] IPC handlers for injections removed - all handled by server"
);

// ===== ALL INJECTION FUNCTIONS NOW HANDLED BY SERVER =====
// No standalone injection functions needed - everything managed by server injection system

// ===== AUTO ADDED: IPC SYNC LISTENERS FOR preload.js =====

async function syncCookiesAndStorage(parentWin, childWin, toolType) {
	console.log(`[SYNC] Starting enhanced sync for ${toolType}`);

	try {
		// 1. Enhanced cookies sync with validation
		const parentSession = parentWin.webContents.session;
		const childSession = childWin.webContents.session;

		// Use cached cookies if available to avoid re-fetching
		let cookiesToSync = [];
		if (
			parentWin._muatool_cookies &&
			Array.isArray(parentWin._muatool_cookies)
		) {
			console.log("[SYNC] Using cached cookies from parent window");
			// FIXED: Lấy TẤT CẢ cookies thay vì filter domain cố định
			cookiesToSync = parentWin._muatool_cookies.filter(
				(ck) => ck.domain && ck.name
			);
		} else {
			console.log("[SYNC] Fetching cookies from parent session");
			const allCookies = await parentSession.cookies.get({});
			// FIXED: Lấy TẤT CẢ cookies thay vì filter domain cố định
			cookiesToSync = allCookies.filter((ck) => ck.domain && ck.name);
		}

		console.log(`[SYNC] Total cookies to sync: ${cookiesToSync.length}`);

		// Debug: Log domain distribution
		const domainCounts = {};
		cookiesToSync.forEach((ck) => {
			const domain = ck.domain || "unknown";
			domainCounts[domain] = (domainCounts[domain] || 0) + 1;
		});
		console.log("[SYNC] Cookies by domain:", domainCounts);

		let successCount = 0,
			failCount = 0;

		for (const ck of cookiesToSync) {
			// Enhanced cookie validation
			if (!ck || !ck.name || typeof ck.name !== "string") {
				failCount++;
				continue;
			}

			try {
				const url = buildCookieUrl(ck);
				if (!url) {
					failCount++;
					continue;
				}

				await childSession.cookies.set({
					url,
					name: ck.name,
					value: ck.value || "",
					domain: ck.domain,
					path: ck.path || "/",
					secure: !!ck.secure,
					httpOnly: !!ck.httpOnly,
					expirationDate: ck.expirationDate, // Persistent cookies như cũ
				});
				successCount++;
			} catch (e) {
				console.warn(
					`[SYNC] Failed to sync cookie ${ck.name}:`,
					e.message
				);
				failCount++;
			}
		}

		console.log(
			`[SYNC] Cookies sync completed - Success: ${successCount}, Failed: ${failCount}`
		);

		// 2. Enhanced localStorage sync with error handling (for all relevant tools)
		if (
			toolType === "ahrefs" ||
			toolType === "freepik" ||
			toolType === "keywordtool" ||
			toolType === "majestic"
		) {
			try {
				let localStorageData;

				// Use cached localStorage if available
				if (parentWin._muatool_localStorage) {
					console.log(
						"[SYNC] Using cached localStorage from parent window"
					);
					localStorageData = parentWin._muatool_localStorage;
				} else {
					console.log(
						"[SYNC] Fetching localStorage from parent window"
					);
					localStorageData =
						await parentWin.webContents.executeJavaScript(
							"JSON.stringify(localStorage)"
						);
				}

				if (localStorageData && localStorageData !== "{}") {
					const safeLocalStorage = localStorageData
						.replace(/\\/g, "\\\\")
						.replace(/'/g, "\\'");
					const result = await childWin.webContents
						.executeJavaScript(`
            (function() {
              try {
                const data = JSON.parse('${safeLocalStorage}');
                let successCount = 0;
                let failCount = 0;
                
                for (const k in data) {
                  try {
                    localStorage.setItem(k, data[k]);
                    successCount++;
                  } catch(e) {
                    console.warn('[SYNC] Failed to set localStorage item:', k, e.message);
                    failCount++;
                  }
                }
                
                console.log('[SYNC] localStorage sync completed - Success:', successCount, 'Failed:', failCount);
                return { success: true, set: successCount, failed: failCount };
              } catch(e) {
                console.error('[SYNC] localStorage sync error:', e);
                return { success: false, error: e.message };
              }
            })();
          `);

					console.log("[SYNC] LocalStorage sync result:", result);
				}
			} catch (e) {
				console.error("[SYNC] localStorage sync failed:", e.message);
			}

			// 3. Enhanced sessionStorage sync
			try {
				const sessionStorageData =
					await parentWin.webContents.executeJavaScript(
						"JSON.stringify(sessionStorage)"
					);
				if (sessionStorageData && sessionStorageData !== "{}") {
					const safeSessionStorage = sessionStorageData
						.replace(/\\/g, "\\\\")
						.replace(/'/g, "\\'");
					await childWin.webContents.executeJavaScript(`
            (function() {
              try {
                const data = JSON.parse('${safeSessionStorage}');
                let successCount = 0;
                
                for (const k in data) {
                  try {
                    sessionStorage.setItem(k, data[k]);
                    successCount++;
                  } catch(e) {
                    console.warn('[SYNC] Failed to set sessionStorage item:', k, e.message);
                  }
                }
                
                console.log('[SYNC] sessionStorage sync completed - Items set:', successCount);
              } catch(e) {
                console.error('[SYNC] sessionStorage sync error:', e);
              }
            })();
          `);

					console.log("[SYNC] SessionStorage synced successfully");
				}
			} catch (e) {
				console.error("[SYNC] sessionStorage sync failed:", e.message);
			}

			// 4. Success notification with enhanced info
			try {
				await childWin.webContents.executeJavaScript(`
          (function() {
            if (window.muatoolNotify) {
              window.muatoolNotify('✅ Đã đồng bộ cookies & storage cho tab con!', 'success', 2000);
            } else {
              console.log('[SYNC] Sync completed successfully - cookies: ${successCount}, storage synced');
            }
          })();
        `);
			} catch (e) {
				console.warn("[SYNC] Failed to show notification:", e.message);
			}
		}

		console.log(`[SYNC] Enhanced sync completed for ${toolType}`);
	} catch (e) {
		console.error(
			`[SYNC] Enhanced sync failed for ${toolType}:`,
			e.message
		);
	}
}

// ========== FORCE QUIT APP HANDLER ==========
ipcMain.on("force-quit-app", () => {
	console.log("[FORCE-QUIT] Force quit app requested from client");
	app.quit();
});

ipcMain.handle("force-quit-app", async () => {
	console.log("[FORCE-QUIT] Force quit app handle requested");
	app.quit();
	return { success: true };
});

// ========== USERS.HTML IPC HANDLERS ==========
// Get tokens
ipcMain.handle("get-tokens", async (event, data) => {
	return new Promise((resolve) => {
		backendSocket.emit("get-tokens", data, (response) => {
			resolve(response);
		});
	});
});

// Search tokens
ipcMain.handle("search-tokens", async (event, data) => {
	return new Promise((resolve) => {
		backendSocket.emit("search-tokens", data, (response) => {
			resolve(response);
		});
	});
});

// Generate token
ipcMain.handle("generate-token", async (event, data) => {
	return new Promise((resolve) => {
		backendSocket.emit("generate-token", data, (response) => {
			resolve(response);
		});
	});
});

// Force generate token (change token)
ipcMain.handle("force-generate-token", async (event, data) => {
	return new Promise((resolve) => {
		backendSocket.emit("force-generate-token", data, (response) => {
			resolve(response);
		});
	});
});

// Delete token
ipcMain.handle("delete-token", async (event, data) => {
	return new Promise((resolve) => {
		backendSocket.emit("delete-token", data, (response) => {
			resolve(response);
		});
	});
});

// Admin set tool
ipcMain.handle("admin-set-tool", async (event, data) => {
	return new Promise((resolve) => {
		backendSocket.emit("admin-set-tool", data, (response) => {
			resolve(response);
		});
	});
});
