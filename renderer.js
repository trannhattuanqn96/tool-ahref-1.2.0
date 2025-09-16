// renderer.js - MuaTool Dashboard UI
// Chỉ giữ lại phần UI dashboard, socket, và giao tiếp với main.js qua electronAPI
// Không backup cookies/storage/proxy vào localStorage, không tự ý thao tác tool/account

// Global error handlers
window.addEventListener('error', (event) => {
  console.error('[GLOBAL ERROR]', event.error);
  // Sẽ hiển thị thông báo sau khi createFloatingMessage được define
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[UNHANDLED REJECTION]', event.reason);
  // Ngăn hiển thị lỗi mặc định
  event.preventDefault();
});

// Kết nối socket để nhận real-time updates
const socket = io('https://app.muatool.com', {
  reconnection: true,
  transports: ['websocket', 'polling'],
  reconnectionDelay: 1000,
  reconnectionAttempts: 10,
  timeout: 20000
});

// Initialize Socket Optimizer for performance monitoring
let socketOptimizer = null;

// Lấy các phần tử UI
const loginBtn = document.getElementById('btnLogin');
const tokenInput = document.getElementById('token');
// const messageBox = document.getElementById('message'); // Lấy khi cần trong showMessage()
const infoBar = document.getElementById('infoBar');
const emailSpan = document.getElementById('userEmail');
const tokenSpan = document.getElementById('tokenInfo');
const userBalanceSpan = document.getElementById('userBalance');
const rechargeBtn = document.getElementById('rechargeBtn');
const transactionHistoryBtn = document.getElementById('transactionHistoryBtn');
const creditAmount = document.getElementById('creditAmount');
const logoutBtn = document.getElementById('logout');
const reloadBtn = document.getElementById('reloadDashboard');
const toolsGrid = document.getElementById('tools');
const loginForm = document.getElementById('loginForm');

let currentToken = null;
let toolsData = [];
let userBalance = 0;

// === AUTO LOGIN RETRY MANAGER ===
const AutoLoginRetry = {
  active: false,
  attempts: 0,
  timer: null,
  maxDelayMs: 30000,
  baseDelayMs: 2000,
  start(token, reason = 'server_unavailable') {
    if (!token) return;
    if (this.active && currentToken !== token) this.stop();
    this.active = true;
    currentToken = token;
    this.scheduleNext(token, reason);
  },
  scheduleNext(token, reason) {
    const delay = Math.min(this.baseDelayMs * Math.pow(2, this.attempts), this.maxDelayMs);
    this.attempts += 1;
    createFloatingMessage(`🛠️ Server đang khởi động (attempt ${this.attempts}). Tự thử lại sau ${Math.round(delay/1000)}s...`, 'warning', 3500);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => autoLoginWithToken(token, true), delay);
  },
  stop() {
    this.active = false;
    this.attempts = 0;
    clearTimeout(this.timer);
    this.timer = null;
  }
};

function isTransientError(errMsg, code) {
  const msg = (errMsg || '').toString().toLowerCase();
  const transientCodes = ['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT_ERROR', 'SYSTEM_ERROR'];
  if (code && transientCodes.includes(code)) return true;
  return [
    'timeout', 'network', 'fetch', 'failed to fetch', 'econn', 'refused', 'unreachable',
    'certificate', 'dns', 'enotfound', 'socket', 'disconnect'
  ].some(k => msg.includes(k));
}

// === ERROR CODE MAPPING SYSTEM ===
const ERROR_CODES = {
  // Authentication errors
  'TOKEN_BLOCKED': {
    icon: '🔒',
    message: 'Token bị khóa do vi phạm bảo mật',
    duration: 10000,
    severity: 'error'
  },
  'TOKEN_EXPIRED': {
    icon: '⏰',
    message: 'Token đã hết hạn, vui lòng đăng nhập lại',
    duration: 8000,
    severity: 'warning'
  },
  'TOKEN_INVALID': {
    icon: '❌',
    message: 'Token không hợp lệ',
    duration: 5000,
    severity: 'error'
  },
  
  // Device errors
  'DEVICE_CONFLICT': {
    icon: '🚫',
    message: 'Token đã được sử dụng trên máy tính khác!\nToken bị khóa trong 5 phút để bảo mật.',
    duration: 15000,
    severity: 'error'
  },
  'DEVICE_ERROR': {
    icon: '📱',
    message: 'Lỗi xác thực thiết bị',
    duration: 8000,
    severity: 'error'
  },
  'DEVICE_LIMIT': {
    icon: '🔢',
    message: 'Đã vượt quá số lượng thiết bị cho phép',
    duration: 10000,
    severity: 'warning'
  },
  
  // Credit errors
  'INSUFFICIENT_CREDIT': {
    icon: '💰',
    message: 'Số dư không đủ để sử dụng tool này',
    duration: 8000,
    severity: 'warning'
  },
  'CREDIT_ERROR': {
    icon: '💳',
    message: 'Lỗi kiểm tra số dư',
    duration: 5000,
    severity: 'error'
  },
  
  // Tool errors
  'TOOL_NOT_FOUND': {
    icon: '🔍',
    message: 'Tool không tồn tại hoặc đã bị gỡ bỏ',
    duration: 5000,
    severity: 'error'
  },
  'TOOL_DISABLED': {
    icon: '🚫',
    message: 'Tool tạm thời bị vô hiệu hóa',
    duration: 8000,
    severity: 'warning'
  },
  'TOOL_MAINTENANCE': {
    icon: '🔧',
    message: 'Tool đang bảo trì, vui lòng thử lại sau',
    duration: 10000,
    severity: 'info'
  },
  'TOOL_ERROR': {
    icon: '⚠️',
    message: 'Lỗi khi thực hiện thao tác với tool',
    duration: 8000,
    severity: 'error'
  },
  
  // Network errors
  'NETWORK_ERROR': {
    icon: '🌐',
    message: 'Lỗi kết nối mạng, vui lòng kiểm tra internet',
    duration: 8000,
    severity: 'error'
  },
  'SERVER_ERROR': {
    icon: '🖥️',
    message: 'Server đang gặp sự cố, vui lòng thử lại sau',
    duration: 10000,
    severity: 'error'
  },
  'TIMEOUT_ERROR': {
    icon: '⏱️',
    message: 'Yêu cầu timeout, vui lòng thử lại',
    duration: 5000,
    severity: 'warning'
  }
};

// Enhanced error message handler
function showErrorMessage(errorCode, customMessage = null, additionalInfo = null) {
  const errorConfig = ERROR_CODES[errorCode];
  
  if (!errorConfig) {
    // Fallback cho unknown error codes
    showMessage(`❌ ${customMessage || 'Lỗi không xác định'}`, 'error');
    return;
  }
  
  let message = `${errorConfig.icon} ${customMessage || errorConfig.message}`;
  if (additionalInfo) {
    message += `\n${additionalInfo}`;
  }
  
  showMessage(message, errorConfig.severity, errorConfig.duration);
}

// === SOCKET EVENT LISTENERS ===

socket.on('connect', () => {
  console.log('[SOCKET] Connected to server');
  
  // Initialize SocketOptimizer cho performance monitoring
  try {
    if (typeof SocketOptimizer !== 'undefined' && !socketOptimizer) {
      socketOptimizer = new SocketOptimizer(socket);
      console.log('[SOCKET] Performance optimizer initialized');
    }
  } catch (e) {
    console.warn('[SOCKET] Failed to initialize optimizer:', e.message);
  }
  
  // Chỉ hiện thông báo kết nối khi user đã đăng nhập
  if (currentToken) {
    createFloatingMessage('🔗 Kết nối server thành công', 'success', 2000);
    
    // Register client để nhận updates
    socket.emit('register-client', {
      token: currentToken,
      clientId: `dashboard_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      email: emailSpan.textContent || 'Unknown',
      userAgent: navigator.userAgent
    });
  }
});

// Socket events - tối ưu thông báo
let lastConnectionTime = 0;
let connectionMessageCount = 0;

socket.on('disconnect', () => {
  // Throttle disconnect messages
  const now = Date.now();
  if (now - lastConnectionTime > 30000) { // Chỉ hiện 1 lần trong 30s
    createFloatingMessage('⚠️ Mất kết nối tới server', 'warning', 3000);
    lastConnectionTime = now;
  }
});

socket.on('connect_error', (error) => {
  console.error('[DASHBOARD] Connection error:', error.message);
  // Throttle error messages
  const now = Date.now();
  if (now - lastConnectionTime > 60000) { // Chỉ hiện 1 lần trong 1 phút
    createFloatingMessage('❌ Lỗi kết nối server', 'error', 5000);
    lastConnectionTime = now;
  }
});

socket.on('reconnect', (attemptNumber) => {
  // Chỉ hiện thông báo reconnect thành công sau lần thứ 2
  if (attemptNumber > 1) {
    createFloatingMessage('✅ Đã kết nối lại server!', 'success', 2000);
  }
});

socket.on('reconnect_error', (error) => {
  // Chỉ log error, không hiện popup liên tục
  console.error('[DASHBOARD] Reconnect error:', error.message);
  if (connectionMessageCount < 3) {
    createFloatingMessage('⚠️ Lỗi kết nối lại server. Đang thử lại...', 'warning', 5000);
    connectionMessageCount++;
  }
});

// Thêm các socket events bổ sung để xử lý mất kết nối
socket.on('reconnect_failed', () => {
  console.error('[SOCKET] All reconnection attempts failed');
  createFloatingMessage('❌ Mất kết nối server! Vui lòng kiểm tra mạng và restart app.', 'error', 10000);
});

socket.on('connect_timeout', () => {
  console.warn('[SOCKET] Connection timeout');
  createFloatingMessage('⏱️ Kết nối server timeout. Đang thử lại...', 'warning', 5000);
});

// Network status monitoring
window.addEventListener('online', () => {
  console.log('[NETWORK] Network connection restored');
  createFloatingMessage('🌐 Kết nối mạng đã được khôi phục!', 'success', 3000);
  // Reconnect socket if disconnected
  if (!socket.connected) {
    console.log('[SOCKET] Attempting to reconnect after network restoration');
    socket.connect();
  }
});

window.addEventListener('offline', () => {
  console.warn('[NETWORK] Network connection lost');
  createFloatingMessage('📡 Mất kết nối mạng! Một số tính năng có thể không hoạt động.', 'error', 8000);
});

// Debug events - chỉ log error và payment events
socket.onAny((eventName, ...args) => {
  if (eventName.includes('error') || eventName.includes('payment') || eventName.includes('fail')) {
    console.log('[SOCKET]', eventName, args);
  }
});

// Force reload dashboard khi bấm nút Làm mới
if (reloadBtn) {
  reloadBtn.addEventListener('click', async () => {
    // Disable button during operation
    reloadBtn.disabled = true;
    reloadBtn.innerHTML = '🔄 Đang làm mới...';
    
    try {
      showMessage('🔄 Đang đồng bộ cookies cho tất cả tool...', 'info');
      
      // Sync cookies for all active tools
      for (const tool of toolsData) {
        if (tool.status === 'active') {
          await manualSyncCookies(tool.code);
        }
      }
      
      // Reload user balance
      loadUserBalance();
      
    } catch (error) {
      console.error('Error during refresh:', error);
      showErrorMessage('SERVER_ERROR', 'Có lỗi xảy ra khi làm mới. Vui lòng thử lại.');
    } finally {
      // Re-enable button
      reloadBtn.disabled = false;
      reloadBtn.innerHTML = '🔄 Làm mới';
    }
  });
}
socket.on('cookies-saved', (data) => {
  console.log('[DASHBOARD] Cookies saved event received:', data);
  
  if (data.success) {
        
    // Enhanced sync with validation
    if (data.account_id) {
      syncCookiesForActiveTool(data.account_id).catch(error => {
        console.error('[DASHBOARD] Auto sync failed after cookie save:', error);
        showMessage('⚠️ Lỗi đồng bộ cookies tự động', 'warning');
      });
    }
  } else {
    console.error('[DASHBOARD] Cookie save failed:', data.error);
    showErrorMessage('SERVER_ERROR', `Lỗi cập nhật cookies: ${data.error || 'Unknown error'}`);
  }
});

socket.on('sync-cookies', async (data) => {
  console.log('[DASHBOARD] Sync cookies event received:', data);
  
  if (data.toolCode && data.cookies) {
    try {
      // Enhanced validation
      if (!Array.isArray(data.cookies)) {
        throw new Error('Invalid cookies format - expected array');
      }
      
      if (data.cookies.length === 0) {
        console.warn('[DASHBOARD] No cookies to sync for:', data.toolCode);
        return;
      }
      
      console.log(`[DASHBOARD] Syncing ${data.cookies.length} cookies for ${data.toolCode}`);
      
      const result = await window.electronAPI.applyCookies(data.toolCode, data.cookies);
      
      if (result && result.success) {
        showMessage(`✅ Đã đồng bộ cookies cho ${data.toolCode}`, 'success');
      } else {
        throw new Error(result?.error || 'Apply cookies failed');
      }
    } catch (e) {
      console.error('[DASHBOARD] Apply cookies error:', e);
      showMessage(`❌ Lỗi đồng bộ cookies cho ${data.toolCode}: ${e.message}`, 'error');
    }
  } else {
    console.warn('[DASHBOARD] Invalid sync-cookies data:', data);
    showMessage('⚠️ Dữ liệu đồng bộ cookies không hợp lệ', 'warning');
  }
});

socket.on('reload-dashboard', () => {
  showMessage('🔄 Dữ liệu đã được cập nhật!', 'info');
  // Tự động reload thông tin tools
  if (currentToken) {
    setTimeout(() => {
      window.electronAPI.getTokenInfo({ token: currentToken }).then(info => {
        if (info && info.success) {
          toolsData = (info.tools || []).map(tool => ({
            code: tool.code,
            name: tool.name,
            status: tool.active ? 'active' : 'inactive',
            expiry: tool.expiry,
            credit: tool.credit,
            max_rows_per_month: tool.max_rows_per_month || 0,
            daily_credit_limit: tool.daily_credit_limit || 0
          }));
          renderTools();
        }
      });
    }, 500);
  }
});

// Socket listener cho tool update realtime
socket.on('tool-updated', (data) => {
  if (data.token === currentToken) {
    // Tìm và cập nhật tool trong toolsData
    const toolIndex = toolsData.findIndex(t => t.code === data.tool_name);
    if (toolIndex !== -1) {
      toolsData[toolIndex].credit = data.credit;
      toolsData[toolIndex].expiry = data.expiry_time;
      toolsData[toolIndex].status = data.active ? 'active' : 'inactive';
      renderTools(); // Re-render để cập nhật UI với ngày giờ mới
      showMessage(`✅ Tool ${data.tool_name} đang được cập nhật!`, 'success');
    }
  }
});

// Socket listener cho token bị block
socket.on('token-blocked', (data) => {
  console.log('[SOCKET] Token blocked event:', data);
  showMessage('🚫 ' + data.message, 'error', 10000);
  
  // Force logout user
  setTimeout(() => {
    currentToken = null;
    userBalance = 0;
    infoBar.style.display = 'none';
    toolsGrid.innerHTML = '';
    toolsGrid.style.display = 'none';
    tokenInput.value = '';
    loginForm.style.display = 'block';
    localStorage.removeItem('muatool_token');
    
    // Đóng app sau 1 giây
    setTimeout(() => {
      window.electronAPI.forceQuitApp();
    }, 1000);
  }, 3000);
});

// Socket listener cho check token status
socket.on('check-token-status', (data) => {
  if (data.blockedToken && currentToken === data.blockedToken) {
    console.log('[SOCKET] Current token is blocked, logging out...');
    showMessage('🚫 Token đã bị khóa! Đang đăng xuất...', 'error', 5000);
    
    // Force logout
    setTimeout(() => {
      currentToken = null;
      userBalance = 0;
      infoBar.style.display = 'none';
      toolsGrid.innerHTML = '';
      toolsGrid.style.display = 'none';
      tokenInput.value = '';
      loginForm.style.display = 'block';
      localStorage.removeItem('muatool_token');
      window.electronAPI.forceQuitApp();
    }, 2000);
  }
});

// === ENHANCED HELPER FUNCTIONS ===
async function syncCookiesForActiveTool(accountId) {
  console.log('[DASHBOARD] Starting auto sync for account:', accountId);
  
  if (!accountId || !currentToken) {
    console.warn('[DASHBOARD] Missing accountId or token for auto sync');
    return;
  }
  
  try {
    // Enhanced validation and retry mechanism
    let attempts = 0;
    const maxAttempts = 3;
    
    const attemptSync = async () => {
      attempts++;
      console.log(`[DASHBOARD] Auto sync attempt ${attempts}/${maxAttempts} for account: ${accountId}`);
      
      try {
        const result = await window.electronAPI.getToolCookies({ 
          token: currentToken, 
          account_id: accountId 
        });
        
        if (!result) {
          throw new Error('No response from getToolCookies');
        }
        
        if (!result.success) {
          throw new Error(result.error || 'getToolCookies failed');
        }
        
        if (!result.cookies || !Array.isArray(result.cookies)) {
          console.warn('[DASHBOARD] No valid cookies returned for account:', accountId);
          return { success: true, message: 'No cookies to sync' };
        }
        
        if (result.cookies.length === 0) {
          console.warn('[DASHBOARD] Empty cookies array for account:', accountId);
          return { success: true, message: 'No cookies to sync' };
        }
        
        console.log(`[DASHBOARD] Got ${result.cookies.length} cookies for ${result.tool_name}`);
        
        // Apply cookies with validation
        const applyResult = await window.electronAPI.applyCookies(result.tool_name, result.cookies);
        
        if (applyResult && !applyResult.success) {
          throw new Error(applyResult.error || 'Apply cookies failed');
        }
        
        console.log(`[DASHBOARD] Successfully synced cookies for ${result.tool_name}`);
        
        
        return { success: true, tool_name: result.tool_name, count: result.cookies.length };
      } catch (error) {
        console.error(`[DASHBOARD] Auto sync attempt ${attempts} failed:`, error.message);
        
        if (attempts < maxAttempts) {
          console.log(`[DASHBOARD] Retrying auto sync in ${attempts * 500}ms...`);
          await new Promise(resolve => setTimeout(resolve, attempts * 500));
          return attemptSync();
        } else {
          throw error;
        }
      }
    };
    
    await attemptSync();
  } catch (e) {
    console.error('[DASHBOARD] Auto sync cookies failed after all attempts:', e.message);
    showMessage(`⚠️ Không thể tự động đồng bộ cookies: ${e.message}`, 'warning');
  }
}

async function manualSyncCookies(toolCode) {
  console.log('[DASHBOARD] Starting manual sync for tool:', toolCode);
  
  if (!currentToken || !toolCode) {
    console.warn('[DASHBOARD] Missing token or toolCode for manual sync');
    showMessage('⚠️ Thiếu thông tin để đồng bộ cookies', 'warning');
    return;
  }
  
  showMessage('🔄 Đang lấy cookies mới nhất...', 'info');
  
  try {
    let attempts = 0;
    const maxAttempts = 2;
    
    const attemptManualSync = async () => {
      attempts++;
      console.log(`[DASHBOARD] Manual sync attempt ${attempts}/${maxAttempts} for tool: ${toolCode}`);
      
      try {
        const result = await window.electronAPI.getToolCookies({ 
          token: currentToken, 
          tool_name: toolCode 
        });
        
        if (!result) {
          throw new Error('No response from getToolCookies');
        }
        
        if (!result.success) {
          throw new Error(result.error || 'Failed to get cookies');
        }
        
        if (!result.cookies || !Array.isArray(result.cookies) || result.cookies.length === 0) {
          showMessage(`⚠️ Không có cookies mới cho ${toolCode}`, 'warning');
          return;
        }
        
        console.log(`[DASHBOARD] Got ${result.cookies.length} cookies for manual sync`);
        
        const applyResult = await window.electronAPI.applyCookies(toolCode, result.cookies);
        
        if (applyResult && !applyResult.success) {
          throw new Error(applyResult.error || 'Apply cookies failed');
        }
        
        showMessage(`✅ Đã đồng bộ cookies cho ${toolCode}`, 'success');
        console.log(`[DASHBOARD] Manual sync completed for ${toolCode}`);
      } catch (error) {
        console.error(`[DASHBOARD] Manual sync attempt ${attempts} failed:`, error.message);
        
        if (attempts < maxAttempts) {
          console.log(`[DASHBOARD] Retrying manual sync...`);
          await new Promise(resolve => setTimeout(resolve, 800));
          return attemptManualSync();
        } else {
          throw error;
        }
      }
    };
    
    await attemptManualSync();
  } catch (e) {
    console.error('[DASHBOARD] Manual sync cookies failed:', e.message);
    showMessage(`❌ Lỗi khi đồng bộ cookies cho ${toolCode}: ${e.message}`, 'error');
  }
}

// Hệ thống quản lý floating message - chống spam
const FloatingMessageManager = {
  lastMessage: '',
  lastMessageTime: 0,
  messageQueue: [],
  isShowing: false,
  
  // Throttle messages giống nhau
  shouldShowMessage(text, type) {
    const now = Date.now();
    const isDuplicate = this.lastMessage === text && (now - this.lastMessageTime) < 3000;
    
    if (isDuplicate) {
      console.log('[FLOATMSG] Skipped duplicate:', text);
      return false;
    }
    
    this.lastMessage = text;
    this.lastMessageTime = now;
    return true;
  },
  
  // Queue messages để tránh overlap
  addToQueue(text, type, timeout) {
    this.messageQueue.push({ text, type, timeout });
    this.processQueue();
  },
  
  processQueue() {
    if (this.isShowing || this.messageQueue.length === 0) return;
    
    const { text, type, timeout } = this.messageQueue.shift();
    this.showMessage(text, type, timeout);
  },
  
  showMessage(text, type, timeout) {
    this.isShowing = true;
    
    // Xóa thông báo cũ
    const oldFloating = document.getElementById('floating-message');
    if (oldFloating) oldFloating.remove();
    
    const floatingDiv = document.createElement('div');
    floatingDiv.id = 'floating-message';
    
    // Style theo type - simplified
    let bgColor, borderColor, textColor;
    switch(type) {
      case 'success':
        bgColor = '#d4edda'; borderColor = '#27ae60'; textColor = '#155724';
        break;
      case 'error':
        bgColor = '#f8d7da'; borderColor = '#dc3545'; textColor = '#721c24';
        break;
      case 'warning':
        bgColor = '#fff3cd'; borderColor = '#ffc107'; textColor = '#856404';
        break;
      default:
        bgColor = '#d1ecf1'; borderColor = '#17a2b8'; textColor = '#0c5460';
    }
    
    floatingDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      max-width: 350px;
      min-width: 250px;
      padding: 15px;
      border-radius: 10px;
      box-shadow: 0 8px 20px rgba(0,0,0,0.15);
      font-family: system-ui, -apple-system, sans-serif;
      font-weight: 500;
      font-size: 14px;
      background: ${bgColor};
      border: 2px solid ${borderColor};
      color: ${textColor};
      cursor: pointer;
      animation: slideInRight 0.3s ease-out;
    `;
    
    floatingDiv.innerHTML = text;
    
    // Click để đóng
    floatingDiv.onclick = () => this.hideMessage(floatingDiv);
    
    document.body.appendChild(floatingDiv);
    
    // Auto hide
    setTimeout(() => this.hideMessage(floatingDiv), timeout);
  },
  
  hideMessage(floatingDiv) {
    if (floatingDiv && floatingDiv.parentNode) {
      floatingDiv.style.animation = 'slideOutRight 0.2s ease-in forwards';
      setTimeout(() => {
        if (floatingDiv.parentNode) floatingDiv.remove();
        this.isShowing = false;
        this.processQueue(); // Process next message
      }, 200);
    } else {
      this.isShowing = false;
      this.processQueue();
    }
  }
};

function showMessage(text, type = 'info', timeout = 4000) {
  createFloatingMessage(text, type, timeout);
}

// Optimized floating message function
function createFloatingMessage(text, type = 'info', timeout = 4000) {
  // Check nếu cần hiển thị
  if (!FloatingMessageManager.shouldShowMessage(text, type)) {
    return;
  }
  
  // Add to queue để tránh overlap
  FloatingMessageManager.addToQueue(text, type, timeout);
}

// Add CSS animations for floating messages - một lần duy nhất
if (!document.getElementById('floating-animation-css')) {
  const style = document.createElement('style');
  style.id = 'floating-animation-css';
  style.textContent = `
    @keyframes slideInRight {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOutRight {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// Tự động đăng nhập nếu có token đã lưu
window.addEventListener('DOMContentLoaded', () => {
  const savedToken = localStorage.getItem('muatool_token');
  const versionBox = document.getElementById('dashboard-version-text');
  if (versionBox) {
    versionBox.textContent = 'v1.2.0';
  }
  if (savedToken) {
    autoLoginWithToken(savedToken);
  }
});

async function autoLoginWithToken(token, isRetry = false) {
  tokenInput.value = token;
  loginBtn.disabled = true;
  // Giảm thông báo auto login - chỉ khi cần
  console.log('[AUTO LOGIN] Starting auto login...');
  
  try {
    // 1. Validate device session trước
    const deviceValidation = await window.electronAPI.validateTokenDevice(token);
    // if (!deviceValidation.success) {
    //   let errorMessage = deviceValidation.error;
    //   if (deviceValidation.code === 'TOKEN_BLOCKED') {
    //     errorMessage += ` (Còn ${Math.ceil(deviceValidation.remainingTime / 60)} phút)`;
    //   } else if (deviceValidation.code === 'DEVICE_CONFLICT') {
    //     errorMessage = '🚫 Token đã được sử dụng trên máy tính khác và bị khóa!';
    //   }
    //   // Nếu lỗi tạm thời (server down) thì không xóa token, bật auto-retry
    //   if (isTransientError(deviceValidation.error, deviceValidation.code)) {
    //     AutoLoginRetry.start(token, 'device_validation');
    //     return;
    //   }

    //   showMessage(errorMessage, 'error', 8000);
    //   localStorage.removeItem('muatool_token');
    //   return;
    // }

    // 2. Lấy thông tin token sau khi device validation thành công
    const info = await window.electronAPI.getTokenInfo({ token });
    if (info && info.success) {
      loginForm.style.display = 'none';
      infoBar.style.display = 'block';
      toolsGrid.style.display = 'grid';
      emailSpan.textContent = info.email || 'User';
      // Hiển thị 40% ký tự đầu tiên của token, thêm nút copy
      renderTokenMasked(token);
      
      let successMessage = '✅ Đăng nhập tự động thành công!';
      if (deviceValidation.isNewDevice) {
        successMessage += ' (Device mới đã được đăng ký)';
      }
      showMessage(successMessage, 'success');
      
      currentToken = token;
      
      // Đăng ký socket client
      socket.emit('register-client', {
        token: currentToken,
        clientId: `dashboard_${Date.now()}`,
        email: info.email || 'User'
      });
      
      checkCredit();
      toolsData = (info.tools || []).map(tool => ({
        code: tool.code,
        name: tool.name,
        status: tool.active ? 'active' : 'inactive',
        expiry: tool.expiry,
        credit: tool.credit,
        max_rows_per_month: tool.max_rows_per_month || 0,
        daily_credit_limit: tool.daily_credit_limit || 0
      }));
      renderTools();
      loadUserBalance(); // Always update balance after login

      // Đăng nhập thành công -> dừng retry (nếu có)
      AutoLoginRetry.stop();
    } else {
      // Nếu server tạm thời không sẵn sàng -> bật retry, giữ token
      if (info && isTransientError(info.error, info.code)) {
        AutoLoginRetry.start(token, 'get_token_info');
        return;
      }
      showMessage('❌ Token đã lưu không hợp lệ!', 'error');
      localStorage.removeItem('muatool_token');
    }
  } catch (e) {
    console.error('[AUTO_LOGIN] Error:', e);
    // Lỗi mạng/timeout: giữ token và auto-retry
    if (isTransientError(e.message)) {
      AutoLoginRetry.start(token, 'exception');
    } else {
      showMessage('❌ Lỗi khi tự động đăng nhập!', 'error');
      localStorage.removeItem('muatool_token');
    }
  } finally {
    loginBtn.disabled = false;
  }
}

// Đăng nhập và lấy thông tin user + danh sách tool từ API thực tế
loginBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    showMessage('❌ Vui lòng nhập token!', 'error');
    return;
  }
  currentToken = token;
  showMessage('🔄 Đang kiểm tra token và device...', 'info');
  
  try {
    // 1. Validate device session trước khi lấy thông tin token
    const deviceValidation = await window.electronAPI.validateTokenDevice(token);
    if (!deviceValidation.success) {
      // Hiển thị lỗi device validation
      let errorMessage = deviceValidation.error;
      if (deviceValidation.code === 'TOKEN_BLOCKED') {
        errorMessage += ` (Còn ${Math.ceil(deviceValidation.remainingTime / 60)} phút)`;
      } else if (deviceValidation.code === 'DEVICE_CONFLICT') {
        errorMessage = '🚫 Token đã được sử dụng trên máy tính khác!\n🔒 Token bị khóa trong 5 phút để bảo mật.';
      }
      // Nếu lỗi tạm thời -> bật auto retry, không xóa
      if (isTransientError(deviceValidation.error, deviceValidation.code)) {
        AutoLoginRetry.start(token, 'device_validation_manual');
        return;
      }
      showMessage(errorMessage, 'error', 10000);
      return;
    }

    console.log('[LOGIN] Device validation passed:', deviceValidation);

    // 2. Lấy thông tin token sau khi device validation thành công
    const info = await window.electronAPI.getTokenInfo({ token });
    if (info && info.success) {
      // Ẩn form đăng nhập, show dashboard
      loginForm.style.display = 'none';
      infoBar.style.display = 'block';
      toolsGrid.style.display = 'grid';
      emailSpan.textContent = info.email || 'User';
      // Hiển thị 40% ký tự đầu tiên của token, thêm nút copy
      renderTokenMasked(token);
      
      let successMessage = '✅ Đăng nhập thành công!';
      if (deviceValidation.isNewDevice) {
        successMessage += ' (Device mới đã được đăng ký)';
      }
      showMessage(successMessage, 'success');
      
      localStorage.setItem('muatool_token', token);
      
      // Đăng ký socket client
      socket.emit('register-client', {
        token: currentToken,
        clientId: `dashboard_${Date.now()}`,
        email: info.email || 'User'
      });
      
      checkCredit();
      toolsData = (info.tools || []).map(tool => ({
        code: tool.code,
        name: tool.name,
        status: tool.active ? 'active' : 'inactive',
        expiry: tool.expiry,
        credit: tool.credit,
        max_rows_per_month: tool.max_rows_per_month || 0,
        daily_credit_limit: tool.daily_credit_limit || 0
      }));
      renderTools();
      loadUserBalance(); // Always update balance after login
    } else {
      if (info && isTransientError(info.error, info.code)) {
        AutoLoginRetry.start(token, 'get_token_info_manual');
        return;
      }
      showMessage('❌ Token không hợp lệ!', 'error');
    }
  } catch (e) {
    if (isTransientError(e.message)) {
      AutoLoginRetry.start(token, 'exception_manual');
    } else {
      showMessage('❌ Lỗi khi kiểm tra token!', 'error');
    }
  }
});

// Đăng xuất
logoutBtn.addEventListener('click', () => {
  // Emit logout event
  if (currentToken) {
    socket.emit('client-logout', { token: currentToken });
  }
  
  currentToken = null;
  userBalance = 0;
  infoBar.style.display = 'none';
  toolsGrid.innerHTML = '';
  toolsGrid.style.display = 'none';
  tokenInput.value = '';
  loginForm.style.display = 'block';
  localStorage.removeItem('muatool_token');
  showMessage('Đã đăng xuất!', 'success');
});

// Event listener cho nút Nạp tiền
rechargeBtn.addEventListener('click', () => {
  document.getElementById('rechargeModal').style.display = 'block';
  // Reset form và ẩn QR cũ
  document.getElementById('rechargeForm').reset();
  document.getElementById('paymentInstructions').style.display = 'none';
  // Reset selected amount buttons
  document.querySelectorAll('.amount-btn').forEach(btn => {
    btn.style.background = 'white';
    btn.style.borderColor = '#ddd';
    btn.style.color = 'black';
  });
});

// Xử lý chọn mệnh giá
document.addEventListener('DOMContentLoaded', () => {
  // Xử lý nút chọn mệnh giá
  document.querySelectorAll('.amount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const amount = btn.getAttribute('data-amount');
      document.getElementById('rechargeAmount').value = amount;
      document.getElementById('customAmount').value = '';
      
      // Reset tất cả nút
      document.querySelectorAll('.amount-btn').forEach(b => {
        b.style.background = 'white';
        b.style.borderColor = '#ddd';
        b.style.color = 'black';
      });
      
      // Highlight nút được chọn
      btn.style.background = '#27ae60';
      btn.style.borderColor = '#27ae60';
      btn.style.color = 'white';
    });
  });

  // Xử lý nhập custom amount
  const customAmountInput = document.getElementById('customAmount');
  if (customAmountInput) {
    customAmountInput.addEventListener('input', (e) => {
      document.getElementById('rechargeAmount').value = e.target.value;
      // Reset tất cả nút khi nhập custom
      document.querySelectorAll('.amount-btn').forEach(b => {
        b.style.background = 'white';
        b.style.borderColor = '#ddd';
        b.style.color = 'black';
      });
    });
  }
});

// Event listener cho nút Lịch sử giao dịch
transactionHistoryBtn.addEventListener('click', () => {
  loadTransactionHistory();
  document.getElementById('transactionModal').style.display = 'block';
});

// Đóng modal nạp tiền
document.getElementById('closeRechargeModal').addEventListener('click', closeRechargeModal);

// Đóng modal lịch sử giao dịch
document.getElementById('closeTransactionModal').addEventListener('click', closeTransactionModal);

// Xử lý form nạp tiền
document.getElementById('rechargeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const amount = parseFloat(document.getElementById('rechargeAmount').value);
  
  if (!amount || amount < 1000) {
    alert('Số tiền nạp tối thiểu là 1,000đ');
    return;
  }
  
  try {
    // Ẩn form nhập tiền và hiện QR thay thế
    const rechargeForm = document.getElementById('rechargeForm');
    const qrBox = document.getElementById('paymentInstructions');
    
    if (rechargeForm) {
      rechargeForm.style.display = 'none'; // Ẩn form nhập tiền
    }
    
    showMessage('🔄 Đang tạo mã QR ...', 'info');
    const token = currentToken || localStorage.getItem('muatool_token');
    showSepayQRDirectFullScreen(amount, token);
  

    // Thêm đồng hồ đếm ngược 10 phút vào QR container
    let countdown = 600; // 10 phút = 600 giây
    const timerDiv = document.createElement('div');
    timerDiv.id = 'qrCountdownTimer';
    timerDiv.style = 'margin-top: 15px; padding: 12px; background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%); border-radius: 8px; color: white; text-align: center;';
    
    // Find the QR container and append timer to it
    const qrContainer = document.getElementById('qrContainer');
    if (qrContainer) {
      timerDiv.innerHTML = `
        <div style="font-size: 13px; font-weight: 600;">⏰ Thời gian còn lại</div>
        <div id="countdownDisplay" style="font-size: 18px; font-weight: 700; font-family: monospace; margin-top: 4px;">10:00</div>
      `;
      qrContainer.appendChild(timerDiv);
    }
    
    function updateTimer() {
      const min = Math.floor(countdown / 60);
      const sec = countdown % 60;
      const countdownDisplay = document.getElementById('countdownDisplay');
      if (countdownDisplay) {
        countdownDisplay.textContent = `${min}:${sec.toString().padStart(2,'0')}`;
      }
      if (countdown <= 0) {
        clearInterval(timerInterval);
        closeRechargeModal();
        showMessage('⏰ Hết thời gian chờ QR. Vui lòng tạo lại mã QR nếu muốn nạp tiếp.', 'warning');
      }
      countdown--;
    }
    updateTimer();
    const timerInterval = setInterval(updateTimer, 1000);

    // Lưu timer để clear khi đóng modal
    window.currentPaymentTimer = timerInterval;
  }
  catch (error) {
    alert('Lỗi khi tạo yêu cầu nạp tiền: ' + error.message);
  }
});

// Kiểm tra credit
async function checkCredit() {
  if (!currentToken) return;
  try {
    const res = await window.electronAPI.checkCredit(currentToken);
    if (res && res.success) {
      const el = document.getElementById('creditAmount');
      if (el) el.textContent = res.credit;
    } else {
      const el = document.getElementById('creditAmount');
      if (el) el.textContent = '-';
    }
  } catch (e) {
    const el = document.getElementById('creditAmount');
    if (el) el.textContent = '-';
  }
}

// Xóa hoàn toàn chữ 'Credit:' trên giao diện
const creditBox = document.querySelector('.credit-info');
if (creditBox) {
  creditBox.innerHTML = '';
  // Credit info đã được chuyển vào layout mới, không cần thêm gì ở đây
}

// Ẩn dòng 'Đang kết nối...' nếu có
const connectingText = document.querySelector('body > .connecting-text, .connecting-text');
if (connectingText) connectingText.style.display = 'none';

function renderTools() {
  toolsGrid.innerHTML = '';
  if (!toolsData.length) {
    toolsGrid.innerHTML = '<div>Không có tool nào trong hệ thống.</div>';
    return;
  }
  
  // Sắp xếp: active lên trên, inactive xuống dưới, trong mỗi nhóm A->Z
  const sortedTools = [...toolsData].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return a.name.localeCompare(b.name, 'vi');
  });
  
  sortedTools.forEach(tool => {
    const card = document.createElement('div');
    card.className = 'tool-card';
    
    // Xác định trạng thái hiển thị
    const statusText = tool.status === 'active' ? 'ACTIVE' : 'INACTIVE';
    const statusClass = tool.status === 'active' ? 'status-active' : 'status-inactive';
    
    // Định dạng expiry
    let expiryText = 'Chưa kích hoạt';
    if (tool.status === 'active' && tool.expiry) {
      try {
        const expiryDate = new Date(tool.expiry);
        if (!isNaN(expiryDate.getTime())) {
          expiryText = expiryDate.toLocaleString('vi-VN');
        } else {
          expiryText = 'Lỗi định dạng ngày';
        }
      } catch (e) {
        console.error('Error formatting expiry date:', e, tool.expiry);
        expiryText = 'Lỗi định dạng ngày';
      }
    }
    
    // Định dạng credit theo loại tool
    let creditLabel = 'Credit:';
    let creditValue = '-';
    
    if (tool.status === 'active') {
      const currentCredit = tool.credit || 0;
      
      // Ahrefs: Hiển thị Credit + Export rows từ DB
      if (tool.code === 'ahrefs') {
        const maxRows = tool.max_rows_per_month || 0;
        creditLabel = 'Credit:';
        creditValue = `${currentCredit} | Export rows: ${maxRows.toLocaleString('vi-VN')}`;
      }
      // Daily tools: Hiển thị Credit: X/Y với Y từ DB
      else if (tool.daily_credit_limit > 0) {
        creditValue = `${currentCredit}/${tool.daily_credit_limit}`;
      }
      // Other tools: Hiển thị credit thường
      else {
        creditValue = currentCredit.toString();
      }
    }
    
    card.innerHTML = `
      <div class="tool-header">
        <span class="tool-name">${tool.name}</span>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="tool-actions">
        <button class="btn btn-tool btn-sm" data-code="${tool.code}" ${tool.status !== 'active' ? 'disabled' : ''}>
          ${tool.status === 'active' ? 'OPEN TOOL' : 'INACTIVE'}
        </button>
        <button class="btn btn-buy btn-sm" data-code="${tool.code}">BUY</button>
      </div>
      <div class="tool-info">
        <span class="tool-expiry"><b>Hạn:</b> <span style="color:#3742fa">${expiryText}</span></span><br>
        <span class="tool-credit"><b>${creditLabel}</b> <span style="color:${tool.status === 'active' ? '#009432' : '#999'}">${creditValue}</span></span>
      </div>
    `;
    toolsGrid.appendChild(card);
  });
  
  // Gán sự kiện cho nút MỞ TOOL (chỉ cho tool active)
  document.querySelectorAll('.btn-tool:not([disabled])').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const code = e.target.getAttribute('data-code');
      if (currentToken && code) {
        // Lấy credit của tool này
        const tool = toolsData.find(t => t.code === code);
        if (tool && tool.status !== 'active') {
          alert('Tool chưa được kích hoạt. Vui lòng liên hệ admin!');
          return;
        }
        if (tool && typeof tool.credit === 'number' && tool.credit < 0) {
          alert('Gói của bạn đã hết credit. Liên hệ admin để mua tiếp nha!');
          return;
        }
        
        // Open the tool với error handling
        try {
          showMessage(`🔑 Đang mở tool ${code}...`, 'info');
          const result = await window.electronAPI.openTool(code, currentToken);
          
          if (result && !result.success) {
            // Sử dụng enhanced error handler
            if (result.code) {
              showErrorMessage(result.code, null, result.error);
            } else {
              showErrorMessage('TOOL_ERROR', `Không thể mở tool: ${result.error}`);
            }
          } else {
            showMessage(`✅ Tool ${code} đang mở...`, 'success');
          }
        } catch (error) {
          console.error('[OPEN_TOOL] Error:', error);
          showErrorMessage('TOOL_ERROR', `Lỗi khi mở tool ${code}`);
        }
      }
    });
  });
  
  // Gán sự kiện cho nút MUA (cho tất cả tools)
  document.querySelectorAll('.btn-buy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const code = e.target.getAttribute('data-code');
      const tool = toolsData.find(t => t.code === code);
      if (tool) {
        showToolPackages(code, tool.name);
      }
    });
  });
}


// Hàm hiển thị token dạng ẩn và thêm nút copy
function renderTokenMasked(token) {
  try {
    if (!token || typeof token !== 'string' || !tokenSpan) return;
    // Tính số ký tự hiển thị (40%)
    const showLen = Math.ceil(token.length * 0.4);
    const masked = token.slice(0, showLen) + '...';
    tokenSpan.innerHTML = `<span id="maskedToken" style="font-weight:bold;background:#f1f2f6;padding:4px 8px;border-radius:6px;letter-spacing:1px;color:#3742fa;user-select:text;">${masked}</span> <button id="copyTokenBtn" style="margin-left:8px;padding:2px 8px;font-size:12px;cursor:pointer;">Copy token</button>`;
    const btn = document.getElementById('copyTokenBtn');
    btn.onclick = function() {
      try {
        const maskedEl = document.getElementById('maskedToken');
        if (!maskedEl) return;
        maskedEl.textContent = token;
        // Copy to clipboard, fallback nếu bị từ chối quyền
        function fallbackCopy(text) {
          const input = document.createElement('input');
          input.value = text;
          document.body.appendChild(input);
          input.select();
          try {
            document.execCommand('copy');
            btn.textContent = 'Đã copy!';
          } catch (e) {
            btn.textContent = 'Copy lỗi!';
          }
          document.body.removeChild(input);
          setTimeout(() => { btn.textContent = 'Copy token'; maskedEl.textContent = masked; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(token).then(() => {
            btn.textContent = 'Đã copy!';
            setTimeout(() => { btn.textContent = 'Copy token'; maskedEl.textContent = masked; }, 1200);
          }).catch(() => {
            fallbackCopy(token);
          });
        } else {
          fallbackCopy(token);
        }
      } catch (err) {
        // fallback nếu có lỗi bất kỳ
        const maskedEl = document.getElementById('maskedToken');
        if (maskedEl) {
          function fallbackCopy(text) {
            const input = document.createElement('input');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            try {
              document.execCommand('copy');
              btn.textContent = 'Đã copy!';
            } catch (e) {
              btn.textContent = 'Copy lỗi!';
            }
            document.body.removeChild(input);
            setTimeout(() => { btn.textContent = 'Copy token'; maskedEl.textContent = masked; }, 1200);
          }
          fallbackCopy(token);
        }
      }
    }
  } catch (err) {
    // Không làm crash UI
    return;
  }
}

// Add CSS for connection status and amount buttons
const style = document.createElement('style');
style.textContent = `
.connection-status {
  font-size: 12px;
  text-align: left;
}
.connection-status table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
}
.connection-status th, .connection-status td {
  border: 1px solid #ddd;
  padding: 4px 8px;
}
.connection-status th {
  background: #f5f5f5;
}
.amount-btn:hover {
  background: #e8f5e8 !important;
  border-color: #27ae60 !important;
  transform: translateY(-1px);
}
.amount-btn:active {
  transform: translateY(0);
}
#paymentInstructions img {
  max-width: 100%;
  height: auto;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

/* QR Payment Animations */
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.7);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(102, 126, 234, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(102, 126, 234, 0);
  }
}

@keyframes shimmer {
  0% {
    background-position: -200px 0;
  }
  100% {
    background-position: calc(200px + 100%) 0;
  }
}

#paymentInstructions {
  animation: fadeInUp 0.6s ease-out;
}

#paymentInstructions img {
  animation: pulse 2s infinite;
  transition: transform 0.3s ease;
}

#paymentInstructions img:hover {
  transform: scale(1.05);
}

/* Responsive Design */
@media (max-width: 768px) {
  #paymentInstructions > div > div:nth-child(2) > div {
    flex-direction: column !important;
    gap: 20px !important;
  }
  
  #paymentInstructions > div > div:nth-child(2) > div > div:first-child {
    flex: none !important;
    align-self: center;
  }
  
  #paymentInstructions > div > div:nth-child(2) > div > div:first-child > div img {
    width: 160px !important;
    height: 160px !important;
  }
}

/* Loading shimmer effect */
.shimmer {
  background: linear-gradient(to right, #f6f7f8 0%, #edeef1 20%, #f6f7f8 40%, #f6f7f8 100%);
  background-size: 800px 104px;
  animation: shimmer 1.5s linear infinite;
}

/* Button hover effects */
.payment-button {
  position: relative;
  overflow: hidden;
  transition: all 0.3s ease;
}

.payment-button:before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.2),
    transparent
  );
  transition: left 0.5s;
}

.payment-button:hover:before {
  left: 100%;
}

/* Gradient text effect */
.gradient-text {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Card hover effect */
.payment-card {
  transition: all 0.3s ease;
}

.payment-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 40px rgba(0,0,0,0.15) !important;
}

/* Status indicators */
.status-success {
  animation: bounce 0.6s ease-in-out;
}

@keyframes bounce {
  0%, 60%, 75%, 90%, 100% {
    animation-timing-function: cubic-bezier(0.215, 0.610, 0.355, 1.000);
  }
  0% {
    opacity: 0;
    transform: translate3d(0, 3000px, 0);
  }
  60% {
    opacity: 1;
    transform: translate3d(0, -20px, 0);
  }
  75% {
    transform: translate3d(0, -10px, 0);
  }
  90% {
    transform: translate3d(0, -5px, 0);
  }
  100% {
    transform: translate3d(0, 0, 0);
  }
}
`;
document.head.appendChild(style);

// === PAYMENT & TRANSACTION FUNCTIONS ===

// Đóng modal nạp tiền
function closeRechargeModal() {
  // Clear timer countdown nếu có
  if (window.currentPaymentTimer) {
    clearInterval(window.currentPaymentTimer);
    window.currentPaymentTimer = null;
  }
  
  // ĐÃ XÓA: Không còn payment check interval nữa
  
  // Reset lại form và hiển thị
  const rechargeForm = document.getElementById('rechargeForm');
  const paymentInstructions = document.getElementById('paymentInstructions');
  
  if (rechargeForm) rechargeForm.style.display = 'block';
  if (paymentInstructions) paymentInstructions.style.display = 'none';
  
  document.getElementById('rechargeModal').style.display = 'none';
  document.getElementById('rechargeForm').reset();
  
  // Reset selected amount buttons
  document.querySelectorAll('.amount-btn').forEach(btn => {
    btn.style.background = 'white';
    btn.style.borderColor = '#ddd';
    btn.style.color = 'black';
  });
}

// Đóng modal lịch sử giao dịch  
function closeTransactionModal() {
  document.getElementById('transactionModal').style.display = 'none';
}

// Tạo QR SePay trực tiếp bằng link (không cần API)
function showSepayQRDirect(amount, token) {
  const instructionsDiv = document.getElementById('paymentInstructions');
  
  // Thông tin tài khoản SePay
  const accountNumber = '0986001816';
  const bankCode = 'VPBank'; // VPBank
  const template = 'compact';
  
  // Tạo link QR SePay
  const qrUrl = `https://qr.sepay.vn/img?acc=${accountNumber}&bank=${bankCode}&amount=${amount}&des=${encodeURIComponent(paymentCode)}&template=${template}`;  
  const qrContent = `
    <h4>🏦 Quét mã QR để thanh toán</h4>
    <div style="text-align: center; margin: 20px 0;">
      <img src="${qrUrl}" alt="QR Code SePay" style="width: 250px; height: 250px; border: 2px solid #27ae60; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
    </div>
    
    <div style="background: #e8f5e8; border: 2px solid #27ae60; border-radius: 8px; padding: 15px; margin: 15px 0;">
      <h5 style="margin-top: 0; color: #1e7e34;">📋 Thông tin chuyển khoản:</h5>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 14px;">
        <div><strong>🏦 Ngân hàng:</strong> Vietcombank</div>
        <div><strong>💳 STK:</strong> ${accountNumber}</div>
        <div><strong>👤 Chủ TK:</strong> Trần Minh Công</div>
        <div><strong>💰 Số tiền:</strong> <span style="color: #27ae60; font-weight: bold;">${amount.toLocaleString('vi-VN')}đ</span></div>
      </div>
      <div style="margin-top: 10px; padding: 8px; background: #ffffff; border-radius: 4px; border: 1px dashed #27ae60;">
        <strong>📝 Nội dung:</strong> <code style="background: #f8f9fa; padding: 2px 6px; border-radius: 3px; color: #e74c3c; font-weight: bold;">${token}</code>
      </div>
    </div>
    
    <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 12px; margin: 15px 0;">
      <strong>� Hướng dẫn thanh toán:</strong>
      <ol style="margin: 8px 0; padding-left: 20px; font-size: 14px;">
        <li>Mở app ngân hàng và chọn <strong>"Quét QR"</strong></li>
        <li>Quét mã QR ở trên</li>
        <li>Kiểm tra thông tin: <strong>số tiền ${amount.toLocaleString('vi-VN')}đ</strong></li>
        <li>Kiểm tra nội dung: <strong>${token}</strong></li>
        <li>Xác nhận chuyển khoản</li>
      </ol>
    </div>
    
    <div style="background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 6px; padding: 12px; margin: 15px 0;">
      <p style="margin: 0; color: #721c24; text-align: center;"><strong>⚠️ LưU Ý QUAN TRỌNG</strong></p>
      <ul style="margin: 8px 0; padding-left: 20px; color: #721c24; font-size: 14px;">
        <li><strong>Nội dung chuyển khoản PHẢI chính xác là token của bạn</strong></li>
        <li>Chuyển đúng số tiền để được xử lý tự động</li>
        <li>Tiền sẽ được cộng vào tài khoản trong vòng <strong>1-3 phút</strong></li>
        <li>Nếu sau 5 phút chưa được cộng, vui lòng liên hệ admin</li>
      </ul>
    </div>
    
    <div style="text-align: center; margin-top: 20px; padding: 16px; background: linear-gradient(135deg, rgba(27, 97, 162, 0.1) 0%, rgba(108, 99, 255, 0.1) 100%); border-radius: 12px; border: 2px solid rgba(27, 97, 162, 0.2);">
      <p style="margin: 0; color: #1B61A2; font-weight: 600; font-size: 14px;">
        � <strong>Hệ thống sẽ tự động cộng tiền khi nhận được chuyển khoản!</strong><br>
        <span style="font-size: 13px; opacity: 0.8;">Popup sẽ tự đóng khi thanh toán thành công hoặc sau 10 phút</span>
      </p>
    </div>
  `;
  
  instructionsDiv.innerHTML = qrContent;
  instructionsDiv.style.display = 'block';
  
  // ĐÃ XÓA: Không còn tự động kiểm tra thanh toán nữa
}

// Kiểm tra trạng thái thanh toán tự động
// ĐÃ XÓA: Không còn kiểm tra thanh toán tự động nữa để tránh popup tự đóng

// Chỉ giữ lại countdown timer cho QR

// ĐÃ XÓA: checkPaymentStatusManual - không còn nút kiểm tra thủ công

// Hàm tắt/bật kiểm tra tự động
// ĐÃ XÓA: toggleAutoPaymentCheck - không còn auto check nữa


// Load lịch sử giao dịch
function loadTransactionHistory() {
  if (!currentToken) return;
  
  socket.emit('get-user-transactions', { token: currentToken }, (response) => {
    if (response.success) {
      renderTransactionHistory(response.transactions);
    } else {
      document.getElementById('transactionList').innerHTML = '<p style="text-align: center; color: #e74c3c;">Lỗi khi tải lịch sử giao dịch: ' + response.error + '</p>';
    }
  });
}

// Render lịch sử giao dịch
function renderTransactionHistory(transactions) {
  const transactionList = document.getElementById('transactionList');
  
  if (!transactions || transactions.length === 0) {
    transactionList.innerHTML = '<p style="text-align: center; color: #7f8c8d;">Bạn chưa có giao dịch nào.</p>';
    return;
  }
  
  const tableHtml = `
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background: #f8f9fa;">
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Thời gian</th>
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Hành động</th>
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Tool</th>
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Số tiền</th>
          <th style="padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Trạng thái</th>
        </tr>
      </thead>
      <tbody>
        ${transactions.map(tx => `
          <tr style="border-bottom: 1px solid #dee2e6;">
            <td style="padding: 10px;">${new Date(tx.created_at).toLocaleString('vi-VN')}</td>
            <td style="padding: 10px;">
              <span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; background: ${tx.action === 'nạp' ? '#e8f5e8' : '#e3f2fd'}; color: ${tx.action === 'nạp' ? '#2d7a2d' : '#1565c0'};">
                ${tx.action === 'nạp' ? '💰 Nạp tiền' : '🛒 Mua tool'}
              </span>
            </td>
            <td style="padding: 10px;">${tx.tool_name || tx.tool_code || '-'}</td>
            <td style="padding: 10px; font-weight: 600; color: ${tx.action === 'nạp' ? '#27ae60' : '#e74c3c'};">
              ${tx.action === 'nạp' ? '+' : '-'}${Math.abs(tx.amount).toLocaleString('vi-VN').replace(/,/g, '.')} VND
            </td>
            <td style="padding: 10px;">
              <span style="color: ${tx.status === 'thành công' ? '#27ae60' : tx.status === 'thất bại' ? '#e74c3c' : '#f39c12'}; font-weight: 600;">
                ${getStatusIcon(tx.status)} ${tx.status}
              </span>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  
  transactionList.innerHTML = tableHtml;
}

// Lấy icon trạng thái
function getStatusIcon(status) {
  switch(status) {
    case 'thành công': return '✅';
    case 'thất bại': return '❌';
    case 'đang xử lý': return '⏳';
    default: return '❓';
  }
}

// Load số dư người dùng - Optimized with SocketOptimizer
function loadUserBalance() {
  if (!currentToken) return Promise.resolve();
  
  return new Promise((resolve) => {
    // Đặt timeout để tránh treo vô hạn
    const timeout = setTimeout(() => {
      console.warn('[BALANCE] Timeout loading balance');
      createFloatingMessage('⚠️ Không thể tải số dư. Kiểm tra kết nối mạng.', 'warning', 5000);
      resolve();
    }, 10000); // 10 seconds timeout
    
    // Use optimized emit if available
    if (socketOptimizer) {
      socketOptimizer.trackEmit('get-user-balance', { token: currentToken }, (response) => {
        clearTimeout(timeout);
        handleBalanceResponse(response);
        resolve();
      }, 8000); // 8 second timeout for tracked requests
    } else {
      // Fallback to normal emit
      socket.emit('get-user-balance', { token: currentToken }, (response) => {
        clearTimeout(timeout);
        handleBalanceResponse(response);
        resolve();
      });
    }
  });
}

// Helper function to handle balance response
function handleBalanceResponse(response) {
  if (response && response.success) {
    userBalance = parseInt(response.balance || 0, 10);
    if (userBalanceSpan) {
      userBalanceSpan.textContent = userBalance.toLocaleString('vi-VN') + ' VND';
    }
  } else {
    console.error('[BALANCE] Failed to load balance:', response);
    if (userBalanceSpan) {
      userBalanceSpan.textContent = 'Lỗi tải số dư';
    }
    createFloatingMessage('❌ Không thể tải số dư. Vui lòng thử lại.', 'error', 5000);
  }
}

// Cập nhật nút MUA với giá từ admin
function updateBuyButtons() {
  // Sẽ được gọi sau khi load tool packages từ server
  socket.emit('get-tool-packages', {}, (response) => {
    if (response.success) {
      const packages = response.packages;
      // Cập nhật UI với các gói giá mới
      renderTools(packages);
    }
  });
}

// Socket event listener cho cập nhật số dư realtime
socket.on('balance-updated', (data) => {
  if (data.token === currentToken) {
    userBalance = data.balance;
    if (userBalanceSpan) {
      userBalanceSpan.textContent = userBalance.toLocaleString('vi-VN') + ' VND';
    }
    showMessage('💰 Số dư đã được cập nhật!', 'success');
  }
});

// Socket event listener cho thông báo giao dịch
socket.on('transaction-notification', (data) => {
  if (data.token === currentToken) {
    showMessage(data.message, data.status === 'success' ? 'success' : 'error');
    if (data.status === 'success') {
      loadUserBalance(); // Refresh số dư
      // Đóng modal nạp tiền nếu đang mở
      const rechargeModal = document.getElementById('rechargeModal');
      if (rechargeModal && rechargeModal.style.display === 'block') {
        closeRechargeModal();
      }
    }
  }
});

// Socket event listener cho webhook SePay - CHỈ đóng khi có thông báo thực sự
socket.on('sepay-payment-success', (data) => {
  if (data.token === currentToken) {
    // Load số dư mới trước
    loadUserBalance().then(() => {
      // Lấy số dư từ userBalanceSpan (element đúng)
      const currentBalance = userBalanceSpan?.textContent || 'N/A';
      // Tạo thông báo đẹp với HTML cho SePay
      const successMsg = `
        <div style="text-align: center;">
          <div style="font-size: 24px; margin-bottom: 15px;">🎉THANH TOÁN THÀNH CÔNG!</div>
          <div style="font-size: 18px; margin-bottom: 12px;">
            <strong>Cảm ơn bạn đã nạp tiền!</strong>
          </div>
          <div style="font-size: 16px; margin-bottom: 10px;">
            Số tiền: <strong style="color: #27ae60; font-size: 18px;">+${data.amount.toLocaleString('vi-VN')}đ</strong>
          </div>
          <div style="font-size: 16px;">
            Số dư hiện tại: <strong style="color: #2196F3; font-size: 18px;">${currentBalance}</strong>
          </div>
        </div>
      `;
      
      // Sử dụng floating message thay vì showMessage
      createFloatingMessage(successMsg, 'success', 10000);
    });
    
    // CHỈ đóng modal khi có webhook thành công thực sự
    const rechargeModal = document.getElementById('rechargeModal');
    if (rechargeModal && rechargeModal.style.display === 'block') {
      closeRechargeModal();
    }
  }
});

// Socket event listener cho webhook tổng quát - CHỈ đóng khi có thông báo thực sự
socket.on('payment-success', (data) => {
  if (data.token === currentToken) {
    // Load số dư mới trước
    loadUserBalance().then(() => {
      // Lấy số dư từ userBalanceSpan (element đúng)
      const currentBalance = userBalanceSpan?.textContent || 'N/A';
      const paymentMethod = data.payment_method || 'ngân hàng';
      

      // Tạo thông báo đẹp với HTML cho payment tổng quát
      const successMsg = `
        <div style="text-align: center;">
          <div style="font-size: 24px; margin-bottom: 15px;">💳 THANH TOÁN THÀNH CÔNG!</div>
          <div style="font-size: 18px; margin-bottom: 12px;">
            <strong>Cảm ơn bạn đã nạp tiền!</strong>
          </div>
          <div style="font-size: 16px; margin-bottom: 10px;">
            Số tiền: <strong style="color: #27ae60; font-size: 18px;">+${data.amount.toLocaleString('vi-VN')}đ</strong>
          </div>
          <div style="font-size: 14px; margin-bottom: 10px; color: #666;">
            Phương thức: ${paymentMethod}
          </div>
          <div style="font-size: 16px;">
            Số dư hiện tại: <strong style="color: #2196F3; font-size: 18px;">${currentBalance}</strong>
          </div>
        </div>
      `;
      
      // Sử dụng floating message thay vì showMessage
      createFloatingMessage(successMsg, 'success', 10000);
    });
    
    // CHỈ đóng modal khi có webhook thành công thực sự
    const rechargeModal = document.getElementById('rechargeModal');
    if (rechargeModal && rechargeModal.style.display === 'block') {
      closeRechargeModal();
    }
  }
});

// Hiển thị các gói tool để mua
function showToolPackages(toolCode, toolName) {
  if (!currentToken) {
    alert('Vui lòng đăng nhập trước!');
    return;
  }
  
  // Load số dư hiện tại
  loadUserBalance();
  
  // Lấy danh sách gói cho tool này
  socket.emit('get-tool-packages', { tool_name: toolCode }, (response) => {
    if (response.success && response.packages.length > 0) {
      const packages = response.packages.filter(pkg => pkg.active);
      if (packages.length === 0) {
        alert('Hiện tại không có gói nào khả dụng cho tool này. Vui lòng liên hệ admin.');
        return;
      }
      
      showPackageSelectionModal(toolCode, toolName, packages);
    } else {
      alert('Không thể tải danh sách gói. Vui lòng liên hệ admin để được hỗ trợ.');
    }
  });
}

// Hiển thị modal chọn gói
function showPackageSelectionModal(toolCode, toolName, packages) {
  const modalHtml = `
    <div id="packageSelectionModal" style="display: block; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5);">
      <div style="background: white; margin: 8% auto; padding: 25px; width: 500px; border-radius: 12px; position: relative; max-height: 70%; overflow-y: auto;">
        <span id="closePackageModal" style="position: absolute; right: 15px; top: 10px; font-size: 28px; cursor: pointer; color: #aaa;">&times;</span>
        <h3 style="margin-top: 0; color: #2c3e50;">🛒 Chọn gói cho ${toolName}</h3>
        
        <div style="background: #e8f5e8; padding: 10px; border-radius: 6px; margin-bottom: 20px;">
          <span style="color: #2d7a2d; font-weight: 600;">💰 Số dư hiện tại: ${Math.floor(userBalance).toLocaleString('vi-VN')} VND</span>
        </div>
        
        <div id="packageList">
          ${packages.map((pkg, index) => `
            <div class="package-item" style="border: 2px solid #ddd; border-radius: 8px; padding: 15px; margin-bottom: 15px; cursor: pointer; transition: all 0.3s;" onclick="selectPackage(${pkg.id}, ${pkg.price})" onmouseover="this.style.borderColor='#3498db'" onmouseout="this.style.borderColor='#ddd'">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <h4 style="margin: 0 0 8px 0; color: #2c3e50;">${pkg.package_name}</h4>
                  <div style="display: flex; gap: 20px; font-size: 14px; color: #7f8c8d;">
                    <span>⏰ ${pkg.duration_days} ngày</span>
                    <span>⚡ ${pkg.credit_amount.toLocaleString()} credit</span>
                    ${pkg.rows_amount > 0 ? `<span>📊 ${pkg.rows_amount.toLocaleString()} rows</span>` : ''}
                  </div>
                </div>
                <div style="text-align: right;">
                  <div style="font-size: 20px; font-weight: bold; color: #e67e22;">${Math.floor(pkg.price).toLocaleString('vi-VN')} VND</div>
                  <div style="font-size: 12px; color: ${Math.floor(userBalance) >= Math.floor(pkg.price) ? '#27ae60' : '#e74c3c'};">
                    ${Math.floor(userBalance) >= Math.floor(pkg.price) ? '✅ Đủ số dư' : '❌ Không đủ số dư'}
                  </div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
        
        <div style="text-align: center; margin-top: 20px; color: #7f8c8d;">
          <small>💡 Tip: Bạn có thể nạp thêm tiền nếu số dư chưa đủ</small>
        </div>
      </div>
    </div>
  `;
  
  // Thêm modal vào DOM
  const modalContainer = document.createElement('div');
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer);
  
  // Event listener để đóng modal
  document.getElementById('closePackageModal').onclick = () => {
    document.body.removeChild(modalContainer);
  };
  
  // Đóng modal khi click bên ngoài
  document.getElementById('packageSelectionModal').onclick = (e) => {
    if (e.target.id === 'packageSelectionModal') {
      document.body.removeChild(modalContainer);
    }
  };
  
  // Lưu thông tin để xử lý khi chọn gói
  window.currentToolPurchase = {
    toolCode: toolCode,
    toolName: toolName,
    modalContainer: modalContainer
  };
}

// Xử lý khi user chọn gói
function selectPackage(packageId, price) {
  if (!currentToken || !window.currentToolPurchase) return;
  
  const { toolCode, toolName, modalContainer } = window.currentToolPurchase;
  
  // Kiểm tra số dư (luôn dùng số nguyên)
  const intBalance = Math.floor(Number(userBalance));
  const intPrice = Math.floor(Number(price));
  if (intBalance < intPrice) {
    if (confirm(`Số dư của bạn không đủ (thiếu ${(intPrice - intBalance).toLocaleString('vi-VN')} VND). Bạn có muốn nạp thêm tiền không?`)) {
      // Đóng modal hiện tại và mở modal nạp tiền
      document.body.removeChild(modalContainer);
      document.getElementById('rechargeModal').style.display = 'block';
    }
    return;
  }
  
  // Xác nhận mua gói
  if (confirm(`Xác nhận mua gói "${toolName}" với giá ${intPrice.toLocaleString('vi-VN')} VND?`)) {
    // Gửi request mua gói
    socket.emit('user-buy-tool', {
      token: currentToken,
      tool_name: toolCode,
      package_id: packageId,
      balance: intBalance,
      price: intPrice
    }, (response) => {
      if (response.success) {
        showMessage('✅ Mua gói thành công! Tool đã được kích hoạt.', 'success');
        
        // Cập nhật số dư realtime
        userBalance = response.new_balance;
        if (userBalanceSpan) {
          userBalanceSpan.textContent = userBalance.toLocaleString('vi-VN') + ' VND';
        }
        
        // Cập nhật credit và expiry cho tool ngay lập tức
        const toolIndex = toolsData.findIndex(t => t.code === toolCode);
        if (toolIndex !== -1) {
          toolsData[toolIndex].credit = response.credit || 0;
          toolsData[toolIndex].expiry = response.expiry_time; // Sử dụng expiry_time từ server
          toolsData[toolIndex].status = 'active';
          renderTools(); // Re-render ngay để hiện credit mới và ngày hết hạn
        }
        
      } else if (response.need_confirm) {
        // Ahrefs cần confirm reset - hiển thị thông báo rõ ràng về RESET hoàn toàn
        const confirmMessage = `⚠️ CẢNH BÁO AHREFS: Bạn còn ${response.remaining_credit} credit chưa sử dụng.

🔄 Mua gói mới sẽ RESET HOÀN TOÀN (KHÔNG cộng dồn):
• Thời hạn: RESET từ hôm nay theo số ngày của gói mới
• Credit: RESET về giá trị gói mới  
• Rows: RESET về giá trị gói mới

❗ Thời hạn cũ sẽ BỊ XÓA, không cộng dồn!

❓ Bạn có chắc chắn muốn RESET hoàn toàn và mua gói mới?`;
        
        if (confirm(confirmMessage)) {
          // Gửi lại với confirm_reset = true
          socket.emit('user-buy-tool', {
            token: currentToken,
            tool_name: toolCode,
            package_id: packageId,
            confirm_reset: true
            }, (confirmResponse) => {
              if (confirmResponse.success) {
                showMessage('✅ Mua gói thành công! Credit đã được reset.', 'success');
                
                // Cập nhật số dư realtime
                userBalance = confirmResponse.new_balance;
                if (userBalanceSpan) {
                  userBalanceSpan.textContent = userBalance.toLocaleString('vi-VN') + ' VND';
                }
                
                // Cập nhật credit và expiry cho tool ngay lập tức
                const toolIndex = toolsData.findIndex(t => t.code === toolCode);
                if (toolIndex !== -1) {
                  toolsData[toolIndex].credit = confirmResponse.credit || 0;
                  toolsData[toolIndex].expiry = confirmResponse.expiry_time; // Sử dụng expiry_time từ server
                  toolsData[toolIndex].status = 'active';
                  renderTools(); // Re-render ngay để hiện credit mới và ngày hết hạn
                }            } else {
              alert('Lỗi khi mua gói: ' + (confirmResponse.error || 'Unknown error'));
            }
          });
        }
      } else {
        alert('Lỗi khi mua gói: ' + response.error);
      }
      
      // Đóng modal
      document.body.removeChild(modalContainer);
    });
  }
}

// Đóng modal khi click bên ngoài
window.onclick = function(event) {
  const rechargeModal = document.getElementById('rechargeModal');
  const transactionModal = document.getElementById('transactionModal');
  
  if (event.target === rechargeModal) {
    closeRechargeModal();
  }
  if (event.target === transactionModal) {
    closeTransactionModal();
  }
}

// Hàm tạo mã thanh toán ngắn gọn từ token
function generatePaymentCode(token) {
  // Tạo mã thanh toán 8-10 ký tự từ token và timestamp
  const timestamp = Date.now().toString();
  const tokenHash = btoa(token).replace(/[^a-zA-Z0-9]/g, '').substring(0, 6);
  const timeHash = timestamp.slice(-4); // 4 số cuối của timestamp
  const paymentCode = `MT${tokenHash}${timeHash}`.substring(0, 10).toUpperCase();
  
  return paymentCode;
}

// Hàm làm sạch token để tránh lỗi webhook SePay
function sanitizeTokenForSePay(token) {
  // Loại bỏ các ký tự đặc biệt có thể gây lỗi khi quét QR
  // Chỉ giữ lại chữ cái, số và một số ký tự an toàn
  return token.replace(/[^a-zA-Z0-9]/g, '');
}

// Tạo QR SePay toàn màn hình thay thế form
async function showSepayQRDirectFullScreen(amount, token) {
  const instructionsDiv = document.getElementById('paymentInstructions');
  
  // Thông tin tài khoản SePay
  const accountNumber = '0986001816';
  const bankCode = 'VPBank'; // VPBank
  const template = 'compact';
  
  // Làm sạch token để tránh lỗi khi quét QR
  const safeToken = sanitizeTokenForSePay(token);
  const hasSpecialChars = token !== safeToken;
  
  // Tạo mã thanh toán ngắn gọn thay vì dùng token gốc
  const paymentCode = generatePaymentCode(token);
  const qrUrl = `https://qr.sepay.vn/img?acc=${accountNumber}&bank=${bankCode}&amount=${amount}&des=${encodeURIComponent(paymentCode)}&template=${template}`;
  
  // Hiển thị loading state trước
  const loadingContent = `
    <div style="padding: 40px; text-align: center; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 8px 32px rgba(0,0,0,0.1);">
        <div class="shimmer" style="width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 32px; color: white;">⏳</span>
        </div>
        <h3 style="margin: 0 0 10px 0; color: #2c3e50;">Đang tạo mã QR thanh toán...</h3>
        <p style="margin: 0; color: #666; font-size: 14px;">Vui lòng đợi trong giây lát</p>
        <div style="margin-top: 20px; height: 4px; background: #f0f0f0; border-radius: 2px; overflow: hidden;">
          <div style="height: 100%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 2px; animation: shimmer 1.5s linear infinite; width: 60%;"></div>
        </div>
      </div>
    </div>
  `;
  
  instructionsDiv.innerHTML = loadingContent;
  instructionsDiv.style.display = 'block';
  
  // Tạo payment code mapping trên server
  try {
    const response = await fetch('https://app.muatool.com/api/create-payment-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        paymentCode: paymentCode,
        token: token
      })
    });
    
    if (!response.ok) {
      console.error('Failed to create payment code mapping');
      createFloatingMessage('❌ Lỗi tạo mã thanh toán. Vui lòng thử lại.', 'error', 5000);
      return;
    }
    
    const mappingResult = await response.json();
    
  } catch (error) {
    console.error('Error creating payment code mapping:', error);
    
    // Kiểm tra loại lỗi network
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      createFloatingMessage('❌ Không thể kết nối server. Kiểm tra kết nối mạng hoặc tắt VPN/Proxy.', 'error', 8000);
    } else {
      createFloatingMessage('❌ Lỗi kết nối server. Vui lòng thử lại.', 'error', 5000);
    }
    return;
  }
  // Tạo link QR SePay với mã thanh toán ngắn gọn
  const qrContent = `
  
<!-- Overlay, che toàn bộ màn hình -->
<div style="
  position: fixed;
  top: 0; left: 0; width: 100vw; height: 100vh;
  background: rgba(0,0,0,0.13);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
">
  <!-- Card/popup chính -->
  <div style="
    background: #fff;
    border-radius: 18px;
    max-width: 420px;
    width: 100%;
    margin: 32px 12px;
    box-shadow: 0 8px 40px rgba(102, 126, 234, 0.10);
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 0;
    position: relative;
  ">
    <!-- Nút X để đóng -->
    <button onclick="closeRechargeModal()" style="
      position: absolute;
      top: 12px;
      right: 15px;
      background: rgba(255,255,255,0.9);
      border: none;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      font-size: 18px;
      font-weight: bold;
      color: #666;
      cursor: pointer;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    " onmouseover="this.style.background='rgba(231,76,60,0.1)'; this.style.color='#e74c3c'" onmouseout="this.style.background='rgba(255,255,255,0.9)'; this.style.color='#666'">
      ×
    </button>
    <!-- Header -->
    <div style="text-align: center; margin-bottom: 0;">
      <div style="
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 18px 0 13px 0;
        border-radius: 18px 18px 0 0;
        box-shadow: 0 4px 15px rgba(102, 126, 234, 0.14);
      ">
        <h2 style="margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0.5px;">
          🏦 Thanh toán qua SePay
        </h2>
        <p style="margin: 5px 0 0 0; opacity: 0.93; font-size: 14px; font-weight: 400;">
          Quét mã QR để thanh toán nhanh chóng
        </p>
      </div>
    </div>
    <!-- Main Content Card -->
    <div style="
      padding: 32px 24px 20px 24px;
      background: white;
      border-radius: 0 0 18px 18px;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 16px;
    ">
      <!-- Payment Amount Banner -->
      <div style="
        font-size: 34px;
        font-weight: 700;
        background: linear-gradient(90deg, #667eea, #764ba2);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        color: transparent;
        letter-spacing: 1px;
        margin-bottom: 4px;
      ">
        ${amount.toLocaleString('vi-VN')}đ
      </div>
      <div style="font-size: 15px; opacity: 0.88;">Số tiền cần thanh toán</div>
      
      <!-- Thông tin chuyển khoản chi tiết -->
      <div style="
        background: #e8f5e8;
        border: 2px solid #27ae60;
        border-radius: 12px;
        padding: 16px;
        margin: 16px 0;
        text-align: left;
      ">
        <h4 style="margin: 0 0 12px 0; color: #1e7e34; text-align: center;">📋 Thông tin chuyển khoản</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 14px;">
          <div><strong>🏦 Ngân hàng:</strong> VPBank</div>
          <div><strong>💳 STK:</strong> ${accountNumber}</div>
          <div style="grid-column: 1 / -1;"><strong>👤 Chủ TK:</strong> Trần Minh Công</div>
          <div style="grid-column: 1 / -1;"><strong>💰 Số tiền:</strong> <span style="color: #27ae60; font-weight: bold;">${amount.toLocaleString('vi-VN')}đ</span></div>
        </div>
        <div style="margin-top: 12px; padding: 8px; background: #ffffff; border-radius: 6px; border: 1px dashed #27ae60;">
          <strong>📝 Nội dung CK:</strong> <code style="background: #f8f9fa; padding: 2px 6px; border-radius: 3px; color: #e74c3c; font-weight: bold;">${paymentCode}</code>
        </div>
      </div>
      
      <!-- QR and Info Section -->
      <div style="display: flex; justify-content: center;">
        <div style="
          background: #f8f9fb;
          padding: 20px 18px 14px 18px;
          border-radius: 16px;
          border: 2.5px solid #667eea;
          box-shadow: 0 4px 16px rgba(102, 126, 234, 0.09);
          display: flex;
          flex-direction: column;
          align-items: center;
          min-width: 210px;
        ">
          <div style="
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 10px 0;
            border-radius: 9px;
            margin-bottom: 14px;
            width: 100%;
            font-size: 15px;
            font-weight: 600;
          ">
            📱 Quét mã QR
          </div>
          <img src="${qrUrl}" alt="QR Code SePay" style="
            width: 150px;
            height: 150px;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.09);
            border: 2px solid #fff;
            background: #fff;
          ">
          <div style="
            margin-top: 13px;
            font-size: 13px;
            color: #5e5e5e;
            font-weight: 500;
            letter-spacing: 0.1px;
          ">
            Mở app ngân hàng để quét
          </div>
        </div>
      </div>
      
      <!-- Info Message thay vì nút kiểm tra -->
      <div style="background: linear-gradient(135deg, rgba(27, 97, 162, 0.1) 0%, rgba(108, 99, 255, 0.1) 100%); 
          color: #1B61A2; 
          border: 2px solid rgba(27, 97, 162, 0.2); 
          padding: 16px; 
          border-radius: 12px; 
          text-align: center;
          margin-top: 18px;
          font-weight: 600;
          font-size: 14px;">
        💡 <strong>Hệ thống sẽ tự động cộng tiền khi nhận được chuyển khoản!</strong><br>
        <span style="font-size: 13px; opacity: 0.8; font-weight: 500;">Popup sẽ tự đóng khi thanh toán thành công hoặc sau 10 phút</span>
      </div>
      
      <!-- Cảnh báo quan trọng -->
      <div style="
        background: #fff3cd;
        border: 1px solid #ffeaa7;
        border-radius: 8px;
        padding: 12px;
        margin-top: 12px;
        font-size: 13px;
        text-align: left;
      ">
        <p style="margin: 0 0 8px 0; font-weight: 600; color: #856404;">⚠️ Lưu ý quan trọng:</p>
        <ul style="margin: 0; padding-left: 18px; color: #856404;">
          <li>Nội dung chuyển khoản PHẢI đúng: <strong>${paymentCode}</strong></li>
          <li>Chuyển đúng số tiền để được xử lý tự động</li>
          <li>Tiền sẽ được cộng trong vòng 1-3 phút</li>
          <li>QR sẽ tự động hết hạn sau 10 phút</li>
        </ul>
      </div>
      
      <!-- Countdown Timer -->
      <div id="paymentCountdown" style="
        margin-top: 16px;
        padding: 10px 16px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: 25px;
        color: white;
        font-size: 14px;
        font-weight: 600;
        text-align: center;
        box-shadow: 0 4px 15px rgba(102, 126, 234, 0.25);
      ">
        ⏰ Thời gian còn lại: <span id="countdownTimer">10:00</span>
      </div>
      
      <!-- Footer -->
      <div style="
        margin-top: 18px;
        color: #666; 
        font-size: 13px;
        background: #fff;
        padding: 12px 8px;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.03);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
      ">
        🔒 Giao dịch được bảo mật bởi Muatool • ⚡ Xử lý tự động 24/7
      </div>
      
      <!-- Nút Quay lại -->
      <div style="text-align: center; margin-top: 16px;">
        <button onclick="backToRechargeForm()" style="
          background: #6c757d;
          color: white;
          border: none;
          padding: 10px 24px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          font-size: 14px;
          transition: all 0.2s;
          box-shadow: 0 2px 8px rgba(108, 117, 125, 0.2);
        " onmouseover="this.style.background='#5a6268'" onmouseout="this.style.background='#6c757d'">
          ← Quay lại 
        </button>
      </div>
    </div>
  </div>
</div>
  `;
  
  instructionsDiv.innerHTML = qrContent;
  instructionsDiv.style.display = 'block';
  
  // Khởi tạo đồng hồ đếm ngược 10 phút
  let countdown = 600; // 10 phút = 600 giây
  const countdownElement = document.getElementById('countdownTimer');
  
  function updateCountdown() {
    const minutes = Math.floor(countdown / 60);
    const seconds = countdown % 60;
    
    if (countdownElement) {
      countdownElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      
      // Thay đổi màu khi còn ít thời gian
      const paymentCountdownDiv = document.getElementById('paymentCountdown');
      if (paymentCountdownDiv) {
        if (countdown <= 60) {
          // Dưới 1 phút - màu đỏ
          paymentCountdownDiv.style.background = 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)';
          paymentCountdownDiv.style.color = 'white';
        } else if (countdown <= 300) {
          // Dưới 5 phút - màu cam
          paymentCountdownDiv.style.background = 'linear-gradient(135deg, #e67e22 0%, #d35400 100%)';
          paymentCountdownDiv.style.color = 'white';
        }
      }
    }
    
    if (countdown <= 0) {
      clearInterval(paymentTimer);
      showMessage('⏰ QR thanh toán đã hết hạn! Vui lòng tạo mã QR mới.', 'warning');
      closeRechargeModal();
      return;
    }
    
    countdown--;
  }
  
  // Cập nhật ngay lập tức và sau đó mỗi giây
  updateCountdown();
  const paymentTimer = setInterval(updateCountdown, 1000);
  
  // Lưu timer để có thể clear khi đóng modal
  window.currentPaymentTimer = paymentTimer;
  
  // ĐÃ XÓA: Không còn tự động kiểm tra thanh toán nữa
}

// Quay lại form nạp tiền
function backToRechargeForm() {
  // Clear countdown timer nếu có
  if (window.currentPaymentTimer) {
    clearInterval(window.currentPaymentTimer);
    window.currentPaymentTimer = null;
  }
  
  // ĐÃ XÓA: Không còn payment check interval nữa
  
  // Hiện lại form và ẩn QR
  const rechargeForm = document.getElementById('rechargeForm');
  const paymentInstructions = document.getElementById('paymentInstructions');
  
  if (rechargeForm) rechargeForm.style.display = 'block';
  
  if (paymentInstructions) paymentInstructions.style.display = 'none';
  

}

