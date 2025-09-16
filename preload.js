const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ========== ORIGINAL APIs (Backward Compatible) ==========
  // Mở tool với token
  openTool: (tool, token) => ipcRenderer.invoke('open-login-and-get-page', { tool, token }),
  // Lấy thông tin token (danh sách tool, email, ...), dùng cho đăng nhập
  getTokenInfo: (body) => ipcRenderer.invoke('get-token-info', body),
  // Lấy cookies cho tool/account
  getToolCookies: (body) => ipcRenderer.invoke('get-tool-cookies', body),
  // Áp dụng cookies cho tool đang mở
  applyCookies: (toolCode, cookies) => ipcRenderer.invoke('apply-tool-cookies', { toolCode, cookies }),
  // Credit operations - qua server  
  checkCredit: (token) => ipcRenderer.invoke('server-check-credit', { token }),

  // ========== CHUYỂN QUA SERVER - SECURE HYBRID APIS ==========
  // Server-managed credit checking  
  hybridCheckCredit: (token, toolName, action) => 
    ipcRenderer.invoke('server-hybrid-check-credit', { token, toolName, action }),
  
  // Server-managed action performance  
  hybridPerformAction: (token, toolName, action, params) => 
    ipcRenderer.invoke('server-hybrid-perform-action', { token, toolName, action, params }),
  
  // Get complete tool state from server
  hybridGetToolState: (token, toolName) => 
    ipcRenderer.invoke('server-hybrid-get-tool-state', { token, toolName }),
  
  // Update tool state on server
  hybridUpdateToolState: (token, toolName, stateUpdates) => 
    ipcRenderer.invoke('server-hybrid-update-tool-state', { token, toolName, stateUpdates }),

  // ========== ENHANCED TOOL MANAGEMENT ==========
  // Apply storage data
  applyStorage: (toolCode, storage) => ipcRenderer.invoke('apply-tool-storage', { toolCode, storage }),
  // Apply proxy settings  
  applyProxy: (toolCode, proxy) => ipcRenderer.invoke('apply-tool-proxy', { toolCode, proxy }),

  // Get connection status for a tool type
  getConnectionStatus: (toolType, token) => ipcRenderer.invoke('get-connection-status', { tool_type: toolType, token }),

  // ========== SERVER-MANAGED INJECTION APIS ==========
  // Request injections from server - qua server validation
  requestToolInjections: (token, toolName, toolId) => 
    ipcRenderer.invoke('server-request-tool-injections', { token, toolName, toolId }),
  
  // Request injection updates - qua server validation
  requestInjectionUpdate: (token, toolName, updateType, updateData) => 
    ipcRenderer.invoke('server-request-injection-update', { token, toolName, updateType, updateData }),
  
  // Apply injection - giữ client-side (cần DOM access)  
  applyInjection: (injectionCode) => 
    ipcRenderer.invoke('apply-injection-to-window', { injectionCode }),

  // ========== DEVICE SESSION MANAGEMENT APIS ==========
  // Validate token with device session
  validateTokenDevice: (token) => 
    ipcRenderer.invoke('validate-token-device', { token }),
  
  // Get device info
  getDeviceInfo: () => 
    ipcRenderer.invoke('get-device-info'),

  // ========== FORCE QUIT API ==========
  // Force quit app when token blocked
  forceQuitApp: () => 
    ipcRenderer.invoke('force-quit-app')
});

// ========== ENHANCED IPC HANDLERS ==========

// IPC nhận từ main, inject localStorage (nếu main muốn gửi qua IPC)
ipcRenderer.on('restore-localstorage', (event, storage) => {
  try {
    if (storage && typeof storage === 'object') {
      for (const k in storage) localStorage.setItem(k, storage[k]);
    } else if (typeof storage === 'string') {
      const store = JSON.parse(storage);
      for (const k in store) localStorage.setItem(k, store[k]);
    }
  } catch (e) {
    console.log('[PRELOAD] LocalStorage restore error:', e.message);
  }
});

// Enhanced hybrid tool state management
ipcRenderer.on('hybrid-sync-state', (event, { toolCode, state }) => {
  try {
    console.log('[PRELOAD] Received hybrid state sync for:', toolCode);
    
    // Apply cookies if provided
    if (state.cookies && Array.isArray(state.cookies)) {
      // Cookies are handled by session in main process
      console.log('[PRELOAD] Cookies will be handled by main process');
    }
    
    // Apply localStorage if provided
    if (state.storage && typeof state.storage === 'object') {
      for (const key in state.storage) {
        localStorage.setItem(key, state.storage[key]);
      }
      console.log('[PRELOAD] Applied storage from server state');
    }
    
    // Dispatch custom event for app to handle
    window.dispatchEvent(new CustomEvent('muatool-hybrid-state-sync', {
      detail: { toolCode, state }
    }));
    
  } catch (e) {
    console.log('[PRELOAD] Hybrid state sync error:', e.message);
  }
});

// Real-time credit updates from server
ipcRenderer.on('hybrid-credit-update', (event, { toolCode, credit, canPerformAction, message }) => {
  try {
    console.log('[PRELOAD] Received credit update:', { toolCode, credit, canPerformAction });
    
    // Dispatch custom event for UI updates
    window.dispatchEvent(new CustomEvent('muatool-credit-update', {
      detail: { toolCode, credit, canPerformAction, message }
    }));
    
    // Update DOM elements if they exist
    const creditElement = document.getElementById('muatool-credit-info');
    if (creditElement) {
      const statusColor = canPerformAction ? '#00ff99' : '#ff4444';
      const statusText = canPerformAction ? 'ACTIVE' : 'LIMITED';
      creditElement.style.borderColor = statusColor;
      
      // Update credit display if it contains credit info
      if (creditElement.innerHTML.includes('Credit:')) {
        creditElement.innerHTML = creditElement.innerHTML.replace(
          /Credit: <span[^>]*>\d+<\/span>/,
          `Credit: <span style="color:${statusColor}">${credit}</span>`
        );
      }
    }
    
  } catch (e) {
    console.log('[PRELOAD] Credit update error:', e.message);
  }
});

// ========== ENHANCED FREEPIK HANDLING ==========

// ========== ALL POSTMESSAGE HANDLING NOW SERVER-MANAGED ==========
// No manual postMessage listeners needed - everything handled by server-managed injection system
console.log('[SERVER-MANAGED] PostMessage handling moved to server-managed injection system');

// ========== GLOBAL HYBRID UTILITIES ==========

// ========== CHUYỂN GLOBAL UTILITIES QUA SERVER ==========
window.muatoolHybrid = {
  async checkCredit(token, toolName, action = 'general') {
    try {
      // Gọi qua server thay vì client-side
      return await ipcRenderer.invoke('server-hybrid-check-credit', { token, toolName, action });
    } catch (e) {
      console.error('[SERVER-HYBRID] Check credit error:', e);
      return { success: false, error: e.message };
    }
  },
  
  async performAction(token, toolName, action, params = {}) {
    try {
      // Gọi qua server thay vì client-side
      return await ipcRenderer.invoke('server-hybrid-perform-action', { token, toolName, action, params });
    } catch (e) {
      console.error('[SERVER-HYBRID] Perform action error:', e);
      return { success: false, error: e.message };      
    }
  },
  
  async getToolState(token, toolName) {
    try {
      // Gọi qua server thay vì client-side
      return await ipcRenderer.invoke('server-hybrid-get-tool-state', { token, toolName });
    } catch (e) {
      console.error('[SERVER-HYBRID] Get tool state error:', e);
      return { success: false, error: e.message };
    }
  },
  
  async updateToolState(token, toolName, stateUpdates) {
    try {
      // Gọi qua server thay vì client-side
      return await ipcRenderer.invoke('server-hybrid-update-tool-state', { token, toolName, stateUpdates });
    } catch (e) {
      console.error('[SERVER-HYBRID] Update tool state error:', e);
      return { success: false, error: e.message };
    }
  },

  // ========== SERVER-MANAGED INJECTION UTILITIES ==========
  
  async requestInjections(token, toolName, toolId) {
    try {
      return await ipcRenderer.invoke('server-request-tool-injections', { token, toolName, toolId });
    } catch (e) {
      console.error('[SERVER-INJECTION] Request injections error:', e);
      return { success: false, error: e.message };
    }
  },
  
  async requestInjectionUpdate(token, toolName, updateType, updateData) {
    try {
      return await ipcRenderer.invoke('server-request-injection-update', { token, toolName, updateType, updateData });
    } catch (e) {
      console.error('[SERVER-INJECTION] Request injection update error:', e);
      return { success: false, error: e.message };
    }
  },
  
  // Apply injection - giữ client-side (cần DOM access)
  async applyInjection(injectionCode) {
    try {
      return await ipcRenderer.invoke('apply-injection-to-window', { injectionCode });
    } catch (e) {
      console.error('[INJECTION] Apply injection error:', e);
      return { success: false, error: e.message };
    }
  }
};

console.log('[PRELOAD] Hybrid logic APIs loaded successfully');

window.addEventListener('DOMContentLoaded', () => {
  // 1. Chỉ áp dụng cho keywordtool
  // if (window.location.hostname.includes('keywordtool')) {
  //   document.querySelectorAll('.dropdown-menu-account.dropdown-menu').forEach(el => el.remove());
  // }
    const path = window.location.pathname;
    const hash = window.location.hash;
 
    const isBlockedMe = path === '/api';
    const isBlockedFollowing = path === 'user/billing';
    const isPricing = path === '/user/account';
    const isBlockedAPI = path === '/user/api';
    const isBlockedSubscription = path === '/user/subscription';
    const isBlockedInvite = path === '/user/invite';
    const isBlockedContact = path === '/user/contact';
    if (isBlockedMe || isBlockedFollowing || isPricing || isBlockedAPI || isBlockedSubscription || isBlockedInvite || isBlockedContact) {
      window.location.href = 'https://keywordtool.io/';
      return;
    }
  

// 3. Freepik
  if (window.location.hostname.includes('freepik.com')) {
    const path = window.location.pathname;
    const hash = window.location.hash;
    const isBlockedSubscription = path === '/user/my-subscriptions' && hash === '#from-element=dropdown_menu';
    const isBlockedDeviceManager = path === '/user/device-manager';
    const isBlockedMe = path === '/user/me';
    const isBlockedFollowing = path === '/user/following';
    const isPricing = path === '/pricing';
    if (isBlockedSubscription || isBlockedDeviceManager || isBlockedMe || isBlockedFollowing ||isPricing) {
      window.location.href = 'https://www.freepik.com/';
      return;
    }
  setInterval(() => {
    const accountBtn = document.querySelector('div.items-center.flex.justify-end.lg\\:flex-initial');
    if (accountBtn) accountBtn.style.display = 'none';

    // Ẩn nút Pricing trên header
    const pricingBtn = document.querySelector('a[data-cy="top-pricing-link"]');
    if (pricingBtn && pricingBtn.parentElement) pricingBtn.parentElement.style.display = 'none';
  }, 500);

  }


// ahrefs
if (window.location.hostname.includes('ahrefs')) {
  // Hàm kiểm tra và redirect nếu truy cập các đường dẫn bị chặn (SPA + click link + mọi trường hợp)
  function checkAhrefsBlock() {
    const path = window.location.pathname;
    const blockedAhrefsPaths = [
      '/user/alerts/backlinks',
      '/local-seo',
      '/site-audit',
      '/social-media',
      '/apps',
      '/account/members/confirmed',
      '/account/api-keys',
      '/account/my-account',
      '/account/billing/subscriptions',
      '/pricing'
    ];
    const isSeoToolbar = window.location.hostname === 'ahrefs.com' && path === '/seo-toolbar';
    if (
      blockedAhrefsPaths.includes(path) ||
      path.startsWith('/apps') ||
      isSeoToolbar
    ) {
      if (window.location.href !== 'https://app.ahrefs.com/') {
        window.location.replace('https://app.ahrefs.com/');
      }
      return true;
    }
    return false;
  }
  // Kiểm tra ngay khi load
  checkAhrefsBlock();
  // Lắng nghe thay đổi URL (SPA)
  const _wr_ahrefs = function(type) {
    const orig = history[type];
    return function() {
      const rv = orig.apply(this, arguments);
      window.dispatchEvent(new Event(type));
      return rv;
    };
  };
  history.pushState = _wr_ahrefs('pushState');
  history.replaceState = _wr_ahrefs('replaceState');
  window.addEventListener('popstate', checkAhrefsBlock);
  window.addEventListener('pushState', checkAhrefsBlock);
  window.addEventListener('replaceState', checkAhrefsBlock);
  window.addEventListener('hashchange', checkAhrefsBlock);
  window.addEventListener('load', checkAhrefsBlock);
  window.onpopstate = checkAhrefsBlock;
  window.onpushstate = checkAhrefsBlock;
  window.onreplacestate = checkAhrefsBlock;
  setInterval(checkAhrefsBlock, 500);
  // Chặn click vào các thẻ a dẫn đến các đường dẫn bị chặn
  document.addEventListener('click', function(e) {
    let a = e.target;
    while (a && a.tagName !== 'A' && a !== document.body) a = a.parentElement;
    if (a && a.tagName === 'A' && a.href) {
      try {
        const url = new URL(a.href, window.location.origin);
        const blocked = [
          '/user/alerts/backlinks',
          '/local-seo',
          '/site-audit',
          '/social-media',
          '/apps',
          '/account/members/confirmed',
          '/account/api-keys',
          '/account/my-account',
          '/account/billing/subscriptions',
          '/pricing'
        ];
        if (
          url.hostname.endsWith('ahrefs.com') &&
          (blocked.includes(url.pathname) || url.pathname.startsWith('/apps') || (url.hostname === 'ahrefs.com' && url.pathname === '/seo-toolbar'))
        ) {
          e.preventDefault();
          window.location.replace('https://app.ahrefs.com/');
        }
      } catch (err) {}
    }
  }, true);

  // Chỉ ẩn/xóa 2 khung khi menu All tools đã mở
  setInterval(() => {
    const el = document.querySelector("#body > div > div.css-1eizzdu-header > div");
    if (el) el.remove();

    const exportButton = document.querySelector("#body > div > div.css-1n7gjr9-container > div > div > div > div.css-y8aj3r.css-z7wlu7.css-1k07npk.css-10ganm4 > div > div > div.css-1ncsi83-relativeWrapper > div.css-15dh5hc-expandedRowContent.css-bv106l.css-1lpshlc > div > div > div > div.css-1lxel9s.css-0.css-j4auk-row.css-thqn8b.css-qdmemo > div.css-r8ayo5-headerRight > div > div:nth-child(1) > div > div:nth-child(2) > button > div");
    if (exportButton) {
      exportButton.style.pointerEvents = 'none';
      exportButton.style.opacity = '0.5';
    }
    const navMenu = document.querySelector('#localizejs > nav.navbar.navbar-ahrefs-header.navbar-header-flex.navbar--collapse > ul.nav.nav-icon-menus.navbar--nav-right.flex');
    if (navMenu) navMenu.remove();
    if (navMenu) {
      navMenu.style.display = 'none';
      navMenu.style.pointerEvents = 'none';
    }
    // Chỉ thực hiện khi menu All tools đã mở (menu có data-state="open")
    var allToolsMenu = document.querySelector('div[data-state="open"][aria-describedby]');
    if (allToolsMenu) {
      try {
        var box3 = document.querySelector('[id=":r0:"] > div > div > div > div > div:nth-child(3)');
        if (box3) {
          box3.style.display = 'none';
          box3.remove && box3.remove();
        }
        var box4 = document.querySelector('[id=":r0:"] > div > div > div > div > div:nth-child(4)');
        if (box4) {
          box4.style.display = 'none';
          box4.remove && box4.remove();
        }
      } catch(e) { /* ignore */ }
    }
  }, 500);
}

if (window.location.hostname.includes('pipiads')) {
  // Xóa liên tục bằng interval
  setInterval(() => {
    // Ẩn khối tài khoản (avatar, trial, dropdown user-box)
    const userBox = document.querySelector('.other-container.pp-collapse');
    if (userBox) userBox.style.display = 'none';

    // Ẩn header tài khoản nếu có
    const el = document.querySelector("#body > div > div.css-1eizzdu-header > div");
    if (el) el.remove();

    // Ẩn nút export nếu có
    const exportButton = document.querySelector("#body > div > div.css-1n7gjr9-container > div > div > div > div.css-y8aj3r.css-z7wlu7.css-1k07npk.css-10ganm4 > div > div > div.css-1ncsi83-relativeWrapper > div.css-15dh5hc-expandedRowContent.css-bv106l.css-1lpshlc > div > div > div > div.css-1lxel9s.css-0.css-j4auk-row.css-thqn8b.css-qdmemo > div.css-r8ayo5-headerRight > div > div:nth-child(1) > div > div:nth-child(2) > button > div");
    if (exportButton) {
      exportButton.style.pointerEvents = 'none';
      exportButton.style.opacity = '0.5';
    }

    // Ẩn nút chọn ngôn ngữ ở footer
    document.querySelectorAll('div.language.wt-ml-xs-1').forEach(el => {
      el.style.display = 'none';
    });
    document.querySelectorAll('div[class*="language"][class*="wt-ml"]').forEach(el => {
      el.style.display = 'none';
    });

    // Ẩn các nút có chữ "Pricing", "Account", "Billing"
    document.querySelectorAll('a, button').forEach(el => {
      const txt = el.textContent?.toLowerCase() || '';
      if (txt.includes('pricing') || txt.includes('account') || txt.includes('billing')) {
        el.style.display = 'none';
      }
    });
  }, 500);
  const path = window.location.pathname;
  const langCodes = ['vi','fr','zh','de','es','it','ja','id','ko','tr','pt','nl','th','ru'];
  const userCenterRegex = new RegExp(`^/(?:${langCodes.join('|')})/?user-center(/|$)`);
  const pricingRegex = new RegExp(`^/(?:${langCodes.join('|')})/pricing$`);
  const myCollectionsRegex = new RegExp(`^/(?:${langCodes.join('|')})/my-collections$`);
  const isBlockedUserCenter = userCenterRegex.test(path);
  const isBlockedMyAccount = path === '/user-center/';
  const isBlockedBilling = path === '/user-center/subscriptions';
  const isBlockedTeam = path === '/user-center/team';
  const isPricing = path === '/user-center/setting';
  const isBlockedPricing = path === '/pricing';
  const isBlockedAITools = path === '/pricing?tab=aitools';
  const isBlockedEntry = path === '/entry';
  const isBlockedLangPricing = pricingRegex.test(path);
  const isBlockedLangMyCollections = myCollectionsRegex.test(path);

  if (isBlockedUserCenter || isBlockedMyAccount || isBlockedBilling || isBlockedTeam || isPricing || isBlockedPricing || isBlockedAITools || isBlockedEntry || isBlockedLangPricing || isBlockedLangMyCollections) {
    window.location.href = 'https://www.pipiads.com/';
    return;
  }
}
if (window.location.hostname.includes('semrush')) {
  // Xóa liên tục bằng interval
  setInterval(() => {
    // Ẩn toàn bộ các nút trên thanh menu header (Upgrade, Pricing, Enterprise, More, Avatar)
    document.querySelectorAll('ul.srf-header__menu > li.srf-header__menu-item').forEach(el => {
      el.style.display = 'none';
    });
  }, 500);

  }
// 1of10
if (window.location.hostname.includes('1of10')) {
  // Xóa liên tục bằng interval
  setInterval(() => {
    // Ẩn/xóa avatar tài khoản góc phải trên
    const avatarBtn = document.querySelector('span.relative.flex.h-10.w-10.shrink-0.overflow-hidden.rounded-full');
    if (avatarBtn) avatarBtn.style.display = 'none';

    // Ẩn/xóa nút "Log out"
    document.querySelectorAll('a.inline-flex.items-center.whitespace-nowrap.rounded-md.ring-offset-background').forEach(el => {
      if (el.textContent && el.textContent.trim().toLowerCase() === 'log out') {
        el.style.display = 'none';
      }
    });

    // Ẩn/xóa các nút/trang premium-pricing
    document.querySelectorAll('a[href*="premium-pricing"]').forEach(el => {
      el.style.display = 'none';
    });

    // Ẩn/xóa header cũ nếu còn
    const el = document.querySelector("#body > div > div.css-1eizzdu-header > div");
    if (el) el.remove();

    const exportButton = document.querySelector("#body > div > div.css-1n7gjr9-container > div > div > div > div.css-y8aj3r.css-z7wlu7.css-1k07npk.css-10ganm4 > div > div > div.css-1ncsi83-relativeWrapper > div.css-15dh5hc-expandedRowContent.css-bv106l.css-1lpshlc > div > div > div > div.css-1lxel9s.css-0.css-j4auk-row.css-thqn8b.css-qdmemo > div.css-r8ayo5-headerRight > div > div:nth-child(1) > div > div:nth-child(2) > button > div");
    if (exportButton) {
      exportButton.style.pointerEvents = 'none';
      exportButton.style.opacity = '0.5';
    }
  }, 500);
  const path = window.location.pathname;
  const hash = window.location.hash;
  const isBlockedapikey = path === '/settings';
  const isBlockedMyAccount = path === '/pricing/premium-pricing';
  const isBlockedBilling = path === '/account/billing/subscriptions';
  const isPricing = path === '/pricing';
  if (isBlockedapikey || isBlockedMyAccount || isBlockedBilling || isPricing) {
    window.location.href = 'https://1of10.com/app/';
    return;
  }
}
// bigspy
if (window.location.hostname.includes('bigspy')) {
  // Xóa liên tục bằng interval
  setInterval(() => {
    // Ẩn/xóa các nút chuyển ngôn ngữ
    document.querySelectorAll('a.nav-link[onclick*="switchLanguage"]').forEach(el => {
      el.style.display = 'none';
    }); 
  function removeNavButton() {
      const btn = document.querySelector("#saasbox-nav > div.container.saasbox-container > section > ul:nth-child(3) > li:nth-child(6)");
      if (btn) btn.remove();
  }
  removeNavButton();
  const observer = new MutationObserver(removeNavButton);
  observer.observe(document.body, { childList: true, subtree: true });
    // Ẩn/xóa các nút Gaming Apps, Non-Gaming Apps
    document.querySelectorAll('a.nav-link').forEach(el => {
      if (
        el.textContent.includes('Gaming Apps') ||
        el.textContent.includes('Non-Gaming Apps')
      ) {
        el.style.display = 'none';
      }
    });

    // Ẩn/xóa avatar tài khoản (dựa trên div chứa username)
    document.querySelectorAll('div[style*="max-width: 180px"]').forEach(el => {
      el.style.display = 'none';
    });

    // Ẩn/xóa các mục menu tài khoản (nếu có)
    document.querySelectorAll('span.nav-link.nav-type-icon').forEach(el => {
      el.style.display = 'none';
    });

    // Ẩn/xóa các mục menu có chữ "MY TRACKED", "PRICING"
    document.querySelectorAll('nav.nav a.nav-link').forEach(el => {
      if (
        el.textContent.toUpperCase().includes('MY TRACKED') ||
        el.textContent.toUpperCase().includes('PRICING')
      ) {
        el.style.display = 'none';
      }
    });

    // Ẩn/xóa các nút Profile, My Plan, Setting, Logout trong menu user
    document.querySelectorAll('a.nav-link[href="/nbs-setting"], a.nav-link[href="/user/logout"]').forEach(el => {
      el.style.display = 'none';
    });
    document.querySelectorAll('a.nav-link[onclick*="callZbaseUserCenterPopupOpen"]').forEach(el => {
      el.style.display = 'none';
    });

  }, 500);

  const path = window.location.pathname;
  const hash = window.location.hash;
  const isBlockedapikey = path === '/nbs-setting';
  const isBlockedMyAccount = path === '/pricing/premium-pricing';
  const isBlockedBilling = path === '/account/billing/subscriptions';
  const isPricing = path === '/pricing';
  if (isBlockedapikey || isBlockedMyAccount || isBlockedBilling || isPricing) {
    window.location.href = 'https://bigspy.com/';
    return;
  }
}
// canva
if (window.location.hostname.includes('canva')) {
  // Xóa liên tục bằng interval
  setInterval(() => {
    // Ẩn/xóa avatar tài khoản (icon tròn góc trên)
    document.querySelectorAll('circle.yCT70Q').forEach(el => {
      el.style.display = 'none';
    });

    // Ẩn/xóa nút user menu (button chứa avatar)
    document.querySelectorAll('button[id=":9m:"]').forEach(el => {
      el.style.display = 'none';
    });

    // Ẩn/xóa các nút liên quan đến tài khoản nếu có
    document.querySelectorAll('div[aria-label*="account"], div[aria-label*="profile"]').forEach(el => {
      el.style.display = 'none';
    });
         // Ẩn/xóa nút chọn ngôn ngữ (div.BTLpWw)
    document.querySelectorAll('div.BTLpWw').forEach(el => {
      el.style.display = 'none';
    });

    // Ẩn/xóa các nút có chữ "Pricing", "Account", "Billing"
    document.querySelectorAll('a, button').forEach(el => {
      const txt = el.textContent?.toLowerCase() || '';
      if (txt.includes('pricing') || txt.includes('account') || txt.includes('billing')) {
        el.style.display = 'none';
      }
    });
  }, 500);
  const path = window.location.pathname;
  const hash = window.location.hash;
  const isBlockedapikey = path === '/vi_vn/bang-gia/';
  const isBlockedMyAccount = path === '/vi_vn/bang-gia/#education';
  const isBlockedBilling = path === '/settings/your-account';
  const isPricing = path === '/settings/login-and-security';
  if (isBlockedapikey || isBlockedMyAccount || isBlockedBilling || isPricing) {
    window.location.href = 'https://www.canva.com/';
    return;
  }
}
// spamzilla
if (window.location.hostname.includes('spamzilla')) {
  // Xóa liên tục bằng interval
  setInterval(() => {
    // Ẩn nút Logout (theo href logout)
    document.querySelectorAll('a[href*="/account/logout"]').forEach(el => {
      el.style.display = 'none';
      // Ẩn luôn thẻ <li> cha nếu có
      if (el.parentElement && el.parentElement.tagName === 'LI') {
        el.parentElement.style.display = 'none';
      }
    });

    // Ẩn nút Profile (theo href profile)
    document.querySelectorAll('a[href*="/account/"][title="Profile"]').forEach(el => {
      el.style.display = 'none';
      if (el.parentElement && el.parentElement.tagName === 'LI') {
        el.parentElement.style.display = 'none';
      }
    });

    // Ẩn nút Credits (theo href credits/add)
    document.querySelectorAll('a[href*="/credits/add"]').forEach(el => {
      el.style.display = 'none';
      if (el.parentElement && el.parentElement.tagName === 'LI') {
        el.parentElement.style.display = 'none';
      }
    });
  }, 500);
  const path = window.location.pathname;
  const hash = window.location.hash;
  const isBlockedapikey = path === '/account/';
  const isBlockedMyAccount = path === '/credits/add/';

  if (isBlockedapikey || isBlockedMyAccount ) {
    window.location.href = 'https://www.spamzilla.io/';
    return;
  }
}
// pngtree
if (window.location.hostname.includes('pngtree')) {
  // Xóa liên tục bằng interval
  setInterval(() => {
    // Ẩn nút Logout (theo href logout)
    document.querySelectorAll('a[href*="/account/logout"]').forEach(el => {
      el.style.display = 'none';
      // Ẩn luôn thẻ <li> cha nếu có
      if (el.parentElement && el.parentElement.tagName === 'LI') {
        el.parentElement.style.display = 'none';
      }
    });

    // Ẩn nút Profile (theo href profile)
    document.querySelectorAll('a[href*="/account/"][title="Profile"]').forEach(el => {
      el.style.display = 'none';
      if (el.parentElement && el.parentElement.tagName === 'LI') {
        el.parentElement.style.display = 'none';
      }
    });

    // Ẩn nút Credits (theo href credits/add)
    document.querySelectorAll('a[href*="/credits/add"]').forEach(el => {
      el.style.display = 'none';
      if (el.parentElement && el.parentElement.tagName === 'LI') {
        el.parentElement.style.display = 'none';
      }
    });
  }, 500);
  const path = window.location.pathname;
  const hash = window.location.hash;
  const isBlockedapikey = path === '/affiliate-program';
  const isBlockedMyAccount = path === '/user/my-subscriptions';
  const isBlockedIndividualPlanPricing = path === '/individual-plan-pricing';
  const isBlockedPayEventPage = path === '/pay/pay-event-page';
  const isBlockedEnterprisePlanPricing = path === '/enterprise-plan-pricing';
  const isBlockedMySubscriptions = path === '/user/my-subscriptions';
  const isBlockedMyProjects = path === '/user/my-projects';
  const isBlockedCreditsAdd = path === '/credits/add';
  if (isBlockedapikey || isBlockedMyAccount || isBlockedIndividualPlanPricing || isBlockedPayEventPage || isBlockedEnterprisePlanPricing || isBlockedMySubscriptions || isBlockedMyProjects || isBlockedCreditsAdd) {
    window.location.href = 'https://pngtree.com/';
    return;
  }
}
// envato
if (window.location.hostname.includes('envato')) {
  // Ẩn các nút Pricing trên header và menu
  setInterval(() => {
    // Ẩn mọi nút/link có text Pricing (không phân biệt hoa thường)
    document.querySelectorAll('a, button, div').forEach(el => {
      if (el.textContent && el.textContent.trim().toLowerCase() === 'pricing') {
        el.style.display = 'none';
      }
      if (el.getAttribute && el.getAttribute('href') && el.getAttribute('href').includes('/pricing')) {
        el.style.display = 'none';
      }
    });
  }, 500);
  // Chặn truy cập trang pricing trên mọi subdomain envato
  function checkEnvatoBlock() {
    const path = window.location.pathname;
    if (path === '/pricing') {
      window.location.href = 'https://elements.envato.com/';
      return true;
    }
    return false;
  }
  checkEnvatoBlock();
  // Lắng nghe thay đổi URL (SPA)
  const _wr_envato = function(type) {
    const orig = history[type];
    return function() {
      const rv = orig.apply(this, arguments);
      window.dispatchEvent(new Event(type));
      return rv;
    };
  };
  history.pushState = _wr_envato('pushState');
  history.replaceState = _wr_envato('replaceState');
  window.addEventListener('popstate', checkEnvatoBlock);
  window.addEventListener('pushState', checkEnvatoBlock);
  window.addEventListener('replaceState', checkEnvatoBlock);
  window.addEventListener('hashchange', checkEnvatoBlock);
  setInterval(checkEnvatoBlock, 1000);

}


});
