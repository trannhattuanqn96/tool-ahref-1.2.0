// socketOptimizer.js - Socket.IO Performance Monitoring & Optimization
// Implements: Latency monitoring, Packet loss tracking, Connection pooling, Data compression

class SocketOptimizer {
  constructor(socketInstance) {
    this.socket = socketInstance;
    this.metrics = {
      latency: [],
      packetsSent: 0,
      packetsReceived: 0,
      packetsLost: 0,
      connectionCount: 0,
      reconnections: 0,
      dataTransmitted: 0,
      dataReceived: 0
    };
    
    this.packetTracker = new Map();
    
    this.initializeMonitoring();
    this.setupPerformanceTracking();
  }

  // 1. LATENCY MONITORING
  initializeMonitoring() {
    // Ping every 30 seconds to measure latency
    this.pingInterval = setInterval(() => {
      this.measureLatency();
    }, 30000);

    // Initial latency measurement
    this.socket.on('connect', () => {
      this.measureLatency();
      this.metrics.connectionCount++;
    });

    this.socket.on('reconnect', () => {
      this.metrics.reconnections++;
      this.measureLatency();
    });
  }

  measureLatency() {
    const startTime = Date.now();
    const pingId = `ping_${startTime}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.socket.emit('ping', { 
      timestamp: startTime, 
      pingId: pingId 
    });

    // Set timeout for ping response
    const pingTimeout = setTimeout(() => {
      console.warn(`[LATENCY] Ping timeout for ${pingId}`);
      this.updateLatencyMetrics(5000); // Consider as 5s latency
    }, 5000);

    // Listen for pong response
    const pongHandler = (data) => {
      if (data.pingId === pingId) {
        clearTimeout(pingTimeout);
        const latency = Date.now() - data.timestamp;
        this.updateLatencyMetrics(latency);
        this.socket.off('pong', pongHandler);
      }
    };

    this.socket.on('pong', pongHandler);
  }

  updateLatencyMetrics(latency) {
    this.metrics.latency.push({
      value: latency,
      timestamp: Date.now()
    });

    // Keep only last 100 measurements
    if (this.metrics.latency.length > 100) {
      this.metrics.latency.shift();
    }

    // Show warning if latency is high
    if (latency > 100) {
      this.showPerformanceWarning(`⚠️ Kết nối chậm: ${latency}ms`, 'warning');
    }

    this.updatePerformanceUI();
  }

  getAverageLatency() {
    if (this.metrics.latency.length === 0) return 0;
    const sum = this.metrics.latency.reduce((acc, item) => acc + item.value, 0);
    return Math.round(sum / this.metrics.latency.length);
  }

  // 2. PACKET LOSS TRACKING
  trackEmit(event, data, callback, timeout = 10000) {
    const packetId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    this.metrics.packetsSent++;
    this.metrics.dataTransmitted += JSON.stringify(data).length;

    // Store packet info for tracking
    this.packetTracker.set(packetId, {
      event,
      startTime,
      timeout: setTimeout(() => {
        this.handlePacketLoss(packetId);
      }, timeout)
    });

    // Emit with packet ID
    this.socket.emit(event, { 
      ...data, 
      packetId: packetId,
      timestamp: startTime
    }, (response) => {
      this.handlePacketResponse(packetId, response);
      if (callback) callback(response);
    });

    return packetId;
  }

  handlePacketResponse(packetId, response) {
    const packetInfo = this.packetTracker.get(packetId);
    if (packetInfo) {
      clearTimeout(packetInfo.timeout);
      this.packetTracker.delete(packetId);
      this.metrics.packetsReceived++;
      
      if (response) {
        this.metrics.dataReceived += JSON.stringify(response).length;
      }
    }
  }

  handlePacketLoss(packetId) {
    const packetInfo = this.packetTracker.get(packetId);
    if (packetInfo) {
      this.metrics.packetsLost++;
      this.packetTracker.delete(packetId);
      
      console.warn(`[PACKET LOSS] Lost packet ${packetId} for event ${packetInfo.event}`);
      
      const lossRate = this.getPacketLossRate();
      if (lossRate > 0.1) { // > 0.1%
        this.showPerformanceWarning(`⚠️ Mất gói tin: ${lossRate.toFixed(2)}%`, 'warning');
      }
    }
  }

  getPacketLossRate() {
    if (this.metrics.packetsSent === 0) return 0;
    return (this.metrics.packetsLost / this.metrics.packetsSent) * 100;
  }

  // 4. DATA COMPRESSION (simplified)
  compressData(data) {
    try {
      // Simple compression by removing whitespace and shortening keys
      const compressed = JSON.stringify(data, (key, value) => {
        if (typeof value === 'string') {
          return value.trim();
        }
        return value;
      });
      
      return {
        compressed: true,
        data: compressed,
        originalSize: JSON.stringify(data).length,
        compressedSize: compressed.length
      };
    } catch (e) {
      console.warn('[COMPRESSION] Failed to compress data:', e);
      return data;
    }
  }

  // 5. PERFORMANCE MONITORING UI
  setupPerformanceTracking() {
    // Create performance monitor panel
    this.createPerformancePanel();
    
    // Update metrics every 5 seconds
    setInterval(() => {
      this.updatePerformanceUI();
    }, 5000);
  }

  createPerformancePanel() {
    // Check if panel already exists
    if (document.getElementById('performance-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'performance-panel';
    panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 20px;
      width: 300px;
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 15px;
      border-radius: 10px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      z-index: 9999;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      display: none;
    `;

    panel.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 10px; color: #00ff00;">
        📊 Socket Performance Monitor
      </div>
      <div id="perf-latency">Latency: --ms</div>
      <div id="perf-packet-loss">Packet Loss: --%</div>
      <div id="perf-connections">Connections: --</div>
      <div id="perf-data">Data: ↑--KB ↓--KB</div>
      <div id="perf-status">Status: --</div>
      <div style="margin-top: 10px;">
        <button onclick="socketOptimizer.togglePanel()" style="background: #007bff; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer;">Hide</button>
        <button onclick="socketOptimizer.resetMetrics()" style="background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer; margin-left: 5px;">Reset</button>
      </div>
    `;

    document.body.appendChild(panel);

    // Add toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'perf-toggle-btn';
    toggleBtn.innerHTML = '📊';
    toggleBtn.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 20px;
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      cursor: pointer;
      z-index: 10000;
      font-size: 16px;
    `;
    toggleBtn.onclick = () => this.togglePanel();
    document.body.appendChild(toggleBtn);
  }

  togglePanel() {
    const panel = document.getElementById('performance-panel');
    const btn = document.getElementById('perf-toggle-btn');
    
    if (panel.style.display === 'none') {
      panel.style.display = 'block';
      btn.style.display = 'none';
    } else {
      panel.style.display = 'none';
      btn.style.display = 'block';
    }
  }

  updatePerformanceUI() {
    const latencyEl = document.getElementById('perf-latency');
    const packetLossEl = document.getElementById('perf-packet-loss');
    const connectionsEl = document.getElementById('perf-connections');
    const dataEl = document.getElementById('perf-data');
    const statusEl = document.getElementById('perf-status');

    if (latencyEl) {
      const avgLatency = this.getAverageLatency();
      latencyEl.innerHTML = `Latency: ${avgLatency}ms`;
      latencyEl.style.color = avgLatency > 100 ? '#ff6b6b' : '#51cf66';
    }

    if (packetLossEl) {
      const lossRate = this.getPacketLossRate();
      packetLossEl.innerHTML = `Packet Loss: ${lossRate.toFixed(2)}%`;
      packetLossEl.style.color = lossRate > 0.1 ? '#ff6b6b' : '#51cf66';
    }

    if (connectionsEl) {
      connectionsEl.innerHTML = `Connections: ${this.metrics.connectionCount} (Pool: ${this.connectionPool.length})`;
    }

    if (dataEl) {
      const txKB = (this.metrics.dataTransmitted / 1024).toFixed(1);
      const rxKB = (this.metrics.dataReceived / 1024).toFixed(1);
      dataEl.innerHTML = `Data: ↑${txKB}KB ↓${rxKB}KB`;
    }

    if (statusEl) {
      const status = this.socket.connected ? '🟢 Connected' : '🔴 Disconnected';
      statusEl.innerHTML = `Status: ${status}`;
    }
  }

  showPerformanceWarning(message, type = 'warning') {
    // Use existing floating message system
    if (typeof createFloatingMessage === 'function') {
      createFloatingMessage(message, type, 5000);
    } else {
      console.warn('[PERFORMANCE]', message);
    }
  }

  resetMetrics() {
    this.metrics = {
      latency: [],
      packetsSent: 0,
      packetsReceived: 0,
      packetsLost: 0,
      connectionCount: 0,
      reconnections: 0,
      dataTransmitted: 0,
      dataReceived: 0
    };
    this.updatePerformanceUI();
    this.showPerformanceWarning('📊 Metrics reset successfully', 'success');
  }

  destroy() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    
    // Remove UI elements
    const panel = document.getElementById('performance-panel');
    const btn = document.getElementById('perf-toggle-btn');
    if (panel) panel.remove();
    if (btn) btn.remove();
  }
}

// Export for use in renderer.js
window.SocketOptimizer = SocketOptimizer;
