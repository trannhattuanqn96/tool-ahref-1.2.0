// deviceFingerprint.js - Tạo device fingerprint cho Electron app
const os = require("os");
const crypto = require("crypto");
const { machineId } = require("node-machine-id");
const fs = require("fs");
const path = require("path");

class DeviceFingerprint {
	constructor() {
		this.deviceInfoCache = null;
		// Sử dụng app data directory thay vì temp directory để tránh bị xóa
		const appDataPath =
			process.env.APPDATA || process.env.HOME || os.tmpdir();
		const muatoolDir = path.join(appDataPath, "MuaTool");

		// Tạo thư mục nếu chưa tồn tại
		try {
			if (!fs.existsSync(muatoolDir)) {
				fs.mkdirSync(muatoolDir, { recursive: true });
			}
			this.persistentIdPath = path.join(muatoolDir, "device.id");
		} catch (error) {
			console.warn(
				"[DEVICE] Cannot create app data dir, falling back to temp:",
				error.message
			);
			this.persistentIdPath = path.join(os.tmpdir(), "muatool_device.id");
		}
	}

	/**
	 * Lấy hoặc tạo persistent device ID - Enhanced với fallback mechanisms
	 */
	async getPersistentDeviceId() {
		try {
			// Kiểm tra file persistent ID đã tồn tại chưa
			if (fs.existsSync(this.persistentIdPath)) {
				try {
					const savedId = fs
						.readFileSync(this.persistentIdPath, "utf8")
						.trim();
					if (savedId && savedId.length >= 16) {
						// Đảm bảo ID hợp lệ
						console.log(
							"[DEVICE] Using existing persistent ID:",
							savedId.substring(0, 8) + "..."
						);
						return savedId;
					}
				} catch (readError) {
					console.warn(
						"[DEVICE] Cannot read existing ID file:",
						readError.message
					);
				}
			}

			// Tạo ID mới dựa trên thông tin máy cố định
			console.log("[DEVICE] Creating new persistent device ID...");
			const deviceInfo = await this.getDeviceInfo();
			const persistentId = this.generateStableFingerprint(deviceInfo);

			// Lưu vào file để dùng lần sau
			try {
				fs.writeFileSync(this.persistentIdPath, persistentId, "utf8");
				console.log(
					"[DEVICE] Saved new persistent ID to:",
					this.persistentIdPath
				);
			} catch (writeError) {
				console.warn(
					"[DEVICE] Cannot save persistent ID:",
					writeError.message
				);
			}

			return persistentId;
		} catch (error) {
			console.error("[DEVICE] Error getting persistent ID:", error);
			// Fallback: tạo ID cố định dựa trên thông tin máy
			return this.generateFallbackId();
		}
	}

	/**
	 * Tạo fingerprint ổn định từ device info
	 */
	generateStableFingerprint(deviceInfo) {
		const {
			hostname,
			username,
			platform,
			arch,
			machineId,
			cpuModel,
			cpuCores,
			networkInfo,
		} = deviceInfo;

		// Chỉ sử dụng thông tin CỐ ĐỊNH, không thay đổi giữa các lần khởi động
		const stableData = [
			hostname || "unknown",
			username || "unknown",
			platform || "unknown",
			arch || "unknown",
			machineId || "unknown",
			(cpuModel || "unknown")
				.replace(/\s+/g, " ")
				.trim()
				.substring(0, 50),
			cpuCores || 0,
			this.getStableNetworkFingerprint(networkInfo),
		].join("|");

		// Hash để tạo ID ngắn gọn và ổn định
		const fingerprint = crypto
			.createHash("sha256")
			.update(stableData)
			.digest("hex")
			.substring(0, 32);

		console.log(
			"[DEVICE] Generated stable fingerprint for data:",
			stableData.substring(0, 100) + "..."
		);
		return fingerprint;
	}

	/**
	 * Tạo ID fallback khi có lỗi
	 */
	generateFallbackId() {
		try {
			const fallbackData = [
				os.hostname(),
				os.userInfo().username,
				os.platform(),
				os.arch(),
			].join("|");

			return (
				"fallback_" +
				crypto
					.createHash("md5")
					.update(fallbackData)
					.digest("hex")
					.substring(0, 24)
			);
		} catch (error) {
			// Fallback của fallback
			return (
				"emergency_" +
				Date.now().toString(36) +
				"_" +
				Math.random().toString(36).substring(2, 10)
			);
		}
	}

	/**
	 * Lấy network fingerprint ổn định
	 */
	getStableNetworkFingerprint(networkInfo) {
		if (networkInfo && typeof networkInfo === "string") {
			// Sắp xếp và chỉ lấy MAC addresses, bỏ interface names có thể thay đổi
			const macs = networkInfo
				.split("|")
				.map((item) => item.split(":").slice(1).join(":")) // Lấy phần MAC address
				.filter((mac) => mac && mac.length > 10) // Chỉ lấy MAC hợp lệ
				.sort(); // Sắp xếp để đảm bảo thứ tự cố định

			return macs.join("|");
		}
		return "network_unknown";
	}

	/**
	 * Lấy thông tin chi tiết về device
	 */
	async getDeviceInfo() {
		if (this.deviceInfoCache) {
			return this.deviceInfoCache;
		}

		try {
			const userInfo = os.userInfo();
			let machineIdValue = "";

			try {
				machineIdValue = await machineId();
			} catch (e) {
				machineIdValue = os.hostname() + userInfo.username;
			}

			const deviceInfo = {
				// Thông tin cơ bản của OS
				hostname: os.hostname(),
				username: userInfo.username,
				platform: os.platform(),
				arch: os.arch(),
				release: os.release(),

				// Machine ID duy nhất
				machineId: machineIdValue,

				// Thông tin phần cứng
				totalMemory: os.totalmem(),
				cpuModel: os.cpus()[0]?.model || "unknown",
				cpuCores: os.cpus().length,

				// Timezone
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				timezoneOffset: new Date().getTimezoneOffset(),

				// Thông tin network (MAC address của interface đầu tiên)
				networkInfo: this.getNetworkFingerprint(),

				// Timestamp tạo
				createdAt: Date.now(),
			};

			this.deviceInfoCache = deviceInfo;
			return deviceInfo;
		} catch (error) {
			console.error("[DEVICE] Error getting device info:", error);

			// Fallback minimal info
			return {
				hostname: os.hostname(),
				username: os.userInfo().username,
				platform: os.platform(),
				arch: os.arch(),
				machineId: "fallback_" + Date.now(),
				createdAt: Date.now(),
			};
		}
	}

	/**
	 * Lấy fingerprint từ thông tin network - Enhanced stability
	 */
	getNetworkFingerprint() {
		try {
			const interfaces = os.networkInterfaces();
			const fingerprints = [];

			for (const [name, configs] of Object.entries(interfaces)) {
				if (configs && configs.length > 0) {
					for (const config of configs) {
						// Chỉ lấy MAC address vật lý, không lấy virtual adapters
						if (
							config.mac &&
							config.mac !== "00:00:00:00:00:00" &&
							!config.internal &&
							!name.toLowerCase().includes("virtual") &&
							!name.toLowerCase().includes("loopback") &&
							!name.toLowerCase().includes("vm")
						) {
							fingerprints.push(config.mac);
						}
					}
				}
			}

			return fingerprints.sort().join("|");
		} catch (error) {
			console.warn("[DEVICE] Network fingerprint error:", error.message);
			return "network_unknown";
		}
	}

	/**
	 * Tạo fingerprint từ device info - sử dụng generateStableFingerprint
	 */
	generateFingerprint(deviceInfo) {
		return this.generateStableFingerprint(deviceInfo);
	}

	/**
	 * Thu thập raw data để gửi server - server sẽ tính fingerprint
	 */
	async getDeviceInfoForServer() {
		// const deviceInfo = await this.getDeviceInfo();
		console.log("deviceInfodeviceInfo", deviceInfo);

		const deviceInfo = {
			hostname: "DESKTOP-IC9ECU1",
			username: "admin",
			platform: "win32",
			arch: "x64",
			release: "10.0.19045",
			machineId:
				"6a503591c76cf8469cf9a2e835a60a5e6086a02e2ad36163da3f3b0cdee20584",
			totalMemory: 34179096576,
			cpuModel: "13th Gen Intel(R) Core(TM) i5-13400F",
			cpuCores: 16,
			timezone: "Asia/Bangkok",
			timezoneOffset: -420,
			networkInfo:
				"00:15:5d:70:18:5f|00:15:5d:70:18:5f|00:15:5d:98:d8:60|00:15:5d:98:d8:60|9c:6b:00:68:d5:e4|9c:6b:00:68:d5:e4",
			createdAt: 9755600121058,
		};
		console.log(this.getNetworkMacs());
		return {
			// CHỈ gửi raw data - KHÔNG tính fingerprint ở client
			hostname: deviceInfo.hostname,
			username: deviceInfo.username,
			platform: deviceInfo.platform,
			arch: deviceInfo.arch,
			machineId: deviceInfo.machineId,
			cpuCores: deviceInfo.cpuCores,
			totalMemory: Math.floor(
				deviceInfo.totalMemory / 1024 / 1024 / 1024
			), // GB rounded
			timezone: deviceInfo.timezone,
			networkMacs: this.getNetworkMacs(), // Chỉ MAC addresses
			timestamp: Date.now(),
		};
	}

	/**
	 * Thu thập chỉ MAC addresses để server xử lý
	 */
	getNetworkMacs() {
		try {
			const interfaces = require("os").networkInterfaces();
			const macs = [];

			for (const [name, configs] of Object.entries(interfaces)) {
				if (configs && configs.length > 0) {
					for (const config of configs) {
						if (
							config.mac &&
							config.mac !== "00:00:00:00:00:00" &&
							!config.internal &&
							!name.toLowerCase().includes("virtual") &&
							!name.toLowerCase().includes("loopback") &&
							!name.toLowerCase().includes("vm")
						) {
							macs.push(config.mac);
						}
					}
				}
			}

			return macs.sort().slice(0, 3); // Chỉ lấy 3 MAC đầu
		} catch (error) {
			console.warn("[DEVICE] Network MAC error:", error.message);
			return [];
		}
	}
}

// Export singleton instance
module.exports = new DeviceFingerprint();
