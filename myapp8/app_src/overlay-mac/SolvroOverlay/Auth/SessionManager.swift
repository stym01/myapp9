import Foundation

final class SessionManager {

    static let shared = SessionManager()

    private let tokenFilename = "solvro-token.txt"
    private let tierCacheFilename = "solvro-tier-cache.txt"
    private let pollInterval: TimeInterval = 5

    private var pollTimer: Timer?

    private(set) var token: String = ""
    private(set) var email: String = ""
    private(set) var userTier: Int = 0
    private(set) var isLoggedIn: Bool = false

    var onTokenChanged: (() -> Void)?
    var onSignedOut: (() -> Void)?

    private init() {}

    // MARK: - Cookie header (matches myapp5 HttpSolvro dual-cookie)

    var cookieHeader: String {
        "next-auth.session-token=\(token); __Secure-next-auth.session-token=\(token)"
    }

    // MARK: - Timezone header (matches myapp5's GetTimeZoneInformation → UTC±N)

    var timezoneHeader: String {
        let seconds = TimeZone.current.secondsFromGMT()
        let hours = seconds / 3600
        return "UTC\(hours >= 0 ? "+" : "")\(hours)"
    }

    // MARK: - Startup (matches myapp5 WinMain SOLVRO TOKEN AUTO-LOGIN block)

    func startup() {
        let freshToken = readTokenFromDisk()
        if !freshToken.isEmpty {
            token = freshToken
            isLoggedIn = true
            NSLog("[SessionManager] token found (%d chars), auto-login", token.count)

            let cachedTier = readCachedTier()
            if cachedTier >= 0 {
                userTier = cachedTier
                NSLog("[SessionManager] loaded cached tier=%d", cachedTier)
            }

            AuthService.shared.fetchSolvroUserTier()
            AuthService.shared.fetchSolvroUsage()
            AuthService.shared.fetchSolvroAppConfig()
        } else {
            NSLog("[SessionManager] no token found — user needs to sign in via Solvro app")
        }
    }

    // MARK: - 5-second token file polling (matches myapp5 main loop DYNAMIC TOKEN RE-READ)

    func startTokenPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.pollTokenFile()
        }
    }

    func stopTokenPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func pollTokenFile() {
        let freshToken = readTokenFromDisk()

        if !freshToken.isEmpty && freshToken != token {
            NSLog("[SessionManager] token changed on disk, re-authenticating")
            token = freshToken
            email = ""
            isLoggedIn = true
            userTier = 0

            let cachedTier = readCachedTier()
            if cachedTier >= 0 {
                userTier = cachedTier
                NSLog("[SessionManager] loaded cached tier=%d for new token", cachedTier)
            }

            AuthService.shared.fetchSolvroUserTier()
            AuthService.shared.fetchSolvroUsage()
            AuthService.shared.fetchSolvroAppConfig()
            onTokenChanged?()
        } else if freshToken.isEmpty && !token.isEmpty {
            NSLog("[SessionManager] token removed, user signed out")
            token = ""
            email = ""
            userTier = 0
            isLoggedIn = false
            onSignedOut?()
        }
    }

    // MARK: - Token file I/O

    private func readTokenFromDisk() -> String {
        for path in tokenSearchPaths() {
            if let raw = try? String(contentsOfFile: path, encoding: .utf8) {
                let clean = sanitize(raw)
                if !clean.isEmpty { return clean }
            }
        }
        return ""
    }

    func writeTokenToDisk(_ clean: String) {
        guard let dir = solvroDir() else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(tokenFilename)
        let tmp = file.appendingPathExtension("tmp")
        do {
            try clean.write(to: tmp, atomically: false, encoding: .utf8)
            _ = try FileManager.default.replaceItemAt(file, withItemAt: tmp)
        } catch {
            try? clean.write(to: file, atomically: true, encoding: .utf8)
        }
    }

    private func tokenSearchPaths() -> [String] {
        var paths: [String] = []
        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let cacheDir = appSupport.appendingPathComponent("Solvro/cache/Solvro")
            paths.append(cacheDir.appendingPathComponent(tokenFilename).path)
            let legacyDir = appSupport.appendingPathComponent("solvro")
            paths.append(legacyDir.appendingPathComponent(tokenFilename).path)
        }
        let tmp = NSTemporaryDirectory()
        paths.append((tmp as NSString).appendingPathComponent(tokenFilename))
        return paths
    }

    private func solvroDir() -> URL? {
        guard let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return appSupport.appendingPathComponent("Solvro/cache/Solvro")
    }

    private func sanitize(_ raw: String) -> String {
        var value = raw
        if value.first == "\u{FEFF}" { value = String(value.dropFirst()) }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return "" }
        for scalar in value.unicodeScalars {
            if scalar.value <= 0x20 || scalar.value == 0x7F ||
               scalar == ";" || scalar == "," {
                return ""
            }
        }
        return value
    }

    // MARK: - Tier caching (matches myapp5 ReadCachedTier / WriteCachedTier)

    func readCachedTier() -> Int {
        guard let dir = solvroDir() else { return -1 }
        let path = dir.appendingPathComponent(tierCacheFilename).path
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8),
              let tier = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              tier >= 0, tier <= 2 else { return -1 }
        return tier
    }

    func writeCachedTier(_ tier: Int) {
        guard tier >= 0, tier <= 2, let dir = solvroDir() else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent(tierCacheFilename)
        let tmp = path.appendingPathExtension("tmp")
        do {
            try "\(tier)".write(to: tmp, atomically: false, encoding: .utf8)
            _ = try FileManager.default.replaceItemAt(path, withItemAt: tmp)
        } catch {
            try? "\(tier)".write(to: path, atomically: true, encoding: .utf8)
        }
    }

    // MARK: - Tier update (called by AuthService after FetchSolvroUserTier)

    func updateTier(_ tier: Int, email: String) {
        self.userTier = tier
        if !email.isEmpty { self.email = email }
        writeCachedTier(tier)
        if !token.isEmpty { writeTokenToDisk(token) }
        NSLog("[SessionManager] tier=%d email=%@", tier, self.email)
    }
}
