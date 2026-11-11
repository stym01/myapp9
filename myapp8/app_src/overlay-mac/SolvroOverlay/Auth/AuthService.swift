import Foundation

final class AuthService {

    static let shared = AuthService()
    private let baseURL = "https://solvro.in"
    private let timeout: TimeInterval = 8

    private var usageFetchInFlight = false
    private var configFetchInFlight = false

    private init() {}

    // MARK: - HttpSolvro helper (matches myapp5's HttpSolvro headers exactly)

    private func makeSolvroRequest(endpoint: String, method: String = "GET", body: Data? = nil) -> URLRequest? {
        guard let url = URL(string: "\(baseURL)\(endpoint)") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue(SessionManager.shared.cookieHeader, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("macos", forHTTPHeaderField: "x-solvro-platform")
        request.setValue(SessionManager.shared.timezoneHeader, forHTTPHeaderField: "x-timezone")
        if let body { request.httpBody = body }
        return request
    }

    // MARK: - FetchSolvroUserTier (matches myapp5 exactly: retry 3x, parse subscription.plan, tier 0/1/2)

    func fetchSolvroUserTier() {
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let maxRetries = 3
            let backoffs: [TimeInterval] = [0, 1.5, 4.0]
            var status: Int = 0
            var data: Data?

            for attempt in 0..<maxRetries {
                if attempt > 0 {
                    NSLog("[AuthService] tier retry %d/%d after %.0fms", attempt, maxRetries - 1, backoffs[attempt] * 1000)
                    Thread.sleep(forTimeInterval: backoffs[attempt])
                }

                guard let request = self.makeSolvroRequest(endpoint: "/api/user/me") else { continue }
                let sem = DispatchSemaphore(value: 0)
                var respData: Data?
                var respStatus: Int = 0

                URLSession.shared.dataTask(with: request) { d, response, _ in
                    respData = d
                    respStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
                    sem.signal()
                }.resume()
                sem.wait()

                status = respStatus
                data = respData
                if status == 200 && data != nil && !data!.isEmpty { break }
            }

            guard status == 200, let data, !data.isEmpty else {
                NSLog("[AuthService] tier fetch failed after all retries")
                return
            }

            do {
                guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

                var plan = "free trial"
                if let sub = json["subscription"] as? [String: Any],
                   let p = sub["plan"] as? String {
                    plan = p
                }
                plan = plan.lowercased().replacingOccurrences(of: "_", with: " ")

                let isLegacy = ["1 month", "3 months", "6 months", "12 months", "test 7days"].contains(plan)
                var tier = 0
                if plan.contains("pro+") || plan.contains("pro plus") ||
                   plan.contains("sprint") || plan.contains("eternal") || isLegacy {
                    tier = 2
                } else if plan.contains("pro") {
                    tier = 1
                }

                let email = json["email"] as? String ?? ""

                DispatchQueue.main.async {
                    SessionManager.shared.updateTier(tier, email: email)
                }

                NSLog("[AuthService] plan=[%@] tier=%d", plan, tier)
            } catch {
                NSLog("[AuthService] tier JSON parse failed")
            }
        }
    }

    // MARK: - FetchSolvroUsage (matches myapp5: monthly meters + trial meters)

    func fetchSolvroUsage() {
        guard !usageFetchInFlight else { return }
        usageFetchInFlight = true

        guard let request = makeSolvroRequest(endpoint: "/api/user/usage") else {
            usageFetchInFlight = false
            return
        }

        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            defer { self?.usageFetchInFlight = false }
            guard let data,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }

            do {
                guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

                if let monthly = json["monthly"] as? [String: Any] {
                    let resetsAt = monthly["resetsAt"] as? String ?? ""
                    if let meters = monthly["meters"] as? [[String: Any]] {
                        for meter in meters {
                            let id = meter["id"] as? String ?? ""
                            let used = meter["used"] as? Int ?? 0
                            let limit = meter["limit"] as? Int ?? 0
                            NSLog("[AuthService] usage meter: %@ used=%d limit=%d", id, used, limit)
                        }
                    }
                    NSLog("[AuthService] usage resets at: %@", resetsAt)
                }

                if let trial = json["trial"] as? [String: Any],
                   let meters = trial["meters"] as? [[String: Any]] {
                    for meter in meters {
                        let unit = meter["unit"] as? String ?? ""
                        let used = meter["used"] as? Int ?? 0
                        let limit = meter["limit"] as? Int ?? 0
                        NSLog("[AuthService] trial meter: unit=%@ used=%d limit=%d", unit, used, limit)
                    }
                }
            } catch {}
        }.resume()
    }

    // MARK: - FetchSolvroAppConfig (matches myapp5: GET /api/app-config, public endpoint)

    func fetchSolvroAppConfig() {
        guard !configFetchInFlight else { return }
        configFetchInFlight = true

        guard let url = URL(string: "\(baseURL)/api/app-config") else {
            configFetchInFlight = false
            return
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            defer { self?.configFetchInFlight = false }
            guard let data,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }

            do {
                guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

                if let models = json["models"] as? [[String: Any]], !models.isEmpty {
                    DispatchQueue.main.async {
                        ModelCatalog.shared.updateModels(from: models)
                    }
                }

                NSLog("[AuthService] app-config fetched: %d keys", json.count)
            } catch {}
        }.resume()
    }
}
