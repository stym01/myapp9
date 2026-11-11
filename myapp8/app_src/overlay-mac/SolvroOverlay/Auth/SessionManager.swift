import Foundation

final class SessionManager {

    static let shared = SessionManager()

    private let tokenFilename = "solvro-token.txt"
    private let refreshInterval: TimeInterval = 24 * 60 * 60
    private var refreshTimer: Timer?

    private(set) var token: String = ""
    private(set) var userProfile: UserProfile?

    struct UserProfile {
        let email: String
        let name: String?
        let plan: String?
        let fetchedAt: Date
    }

    private init() {}

    // MARK: - Token reading

    func loadToken() -> Bool {
        token = readTokenFromDisk()
        if !token.isEmpty {
            NSLog("[SessionManager] token loaded (%d chars)", token.count)
            return true
        }
        NSLog("[SessionManager] no valid token found")
        return false
    }

    private func readTokenFromDisk() -> String {
        let paths = tokenSearchPaths()
        for p in paths {
            if let raw = try? String(contentsOfFile: p, encoding: .utf8) {
                let clean = sanitize(raw)
                if !clean.isEmpty {
                    NSLog("[SessionManager] read token from %@", p)
                    return clean
                }
            }
        }
        return ""
    }

    private func tokenSearchPaths() -> [String] {
        var paths: [String] = []

        // Primary: ~/Library/Application Support/Solvro/solvro-token.txt
        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let solvroDir = appSupport.appendingPathComponent("Solvro")
            paths.append(solvroDir.appendingPathComponent(tokenFilename).path)
        }

        // Fallback: $TMPDIR/solvro-token.txt
        let tmp = NSTemporaryDirectory()
        paths.append((tmp as NSString).appendingPathComponent(tokenFilename))

        return paths
    }

    // Matches the Electron sanitize(): strip BOM, trim whitespace, reject control chars
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

    func setToken(_ newToken: String) {
        let clean = sanitize(newToken)
        guard !clean.isEmpty else { return }
        token = clean
        writeTokenToDisk(clean)
    }

    private func writeTokenToDisk(_ clean: String) {
        guard let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let dir = appSupport.appendingPathComponent("Solvro")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(tokenFilename)
        let tmp = file.appendingPathExtension("tmp")
        do {
            try clean.write(to: tmp, atomically: false, encoding: .utf8)
            _ = try FileManager.default.replaceItemAt(file, withItemAt: tmp)
            NSLog("[SessionManager] token written to %@", file.path)
        } catch {
            try? clean.write(to: file, atomically: true, encoding: .utf8)
        }
    }

    // MARK: - Cookie header

    var cookieHeader: String {
        "next-auth.session-token=\(token); __Secure-next-auth.session-token=\(token)"
    }

    var isLoggedIn: Bool { !token.isEmpty }

    // MARK: - Token refresh timer

    func startRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: refreshInterval, repeats: true) { [weak self] _ in
            self?.refreshToken()
        }
        // Also refresh once right away
        refreshToken()
    }

    func stopRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    private func refreshToken() {
        guard !token.isEmpty else { return }
        AuthService.shared.refreshToken { [weak self] newToken in
            guard let self, let newToken, !newToken.isEmpty else { return }
            self.setToken(newToken)
            NSLog("[SessionManager] token refreshed")
        }
    }

    // MARK: - Profile

    func fetchProfile(completion: @escaping (UserProfile?) -> Void) {
        AuthService.shared.fetchUserProfile { [weak self] profile in
            self?.userProfile = profile
            completion(profile)
        }
    }
}
