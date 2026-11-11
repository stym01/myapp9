import Foundation

final class AuthService {

    static let shared = AuthService()
    private let baseURL = "https://solvro.in"
    private let timeout: TimeInterval = 8

    private init() {}

    // MARK: - GET /api/user/me

    func fetchUserProfile(completion: @escaping (SessionManager.UserProfile?) -> Void) {
        guard let url = URL(string: "\(baseURL)/api/user/me") else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.setValue(SessionManager.shared.cookieHeader, forHTTPHeaderField: "Cookie")

        URLSession.shared.dataTask(with: request) { data, response, error in
            guard let data, error == nil,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let email = json["email"] as? String {
                    let profile = SessionManager.UserProfile(
                        email: email,
                        name: json["name"] as? String,
                        plan: json["plan"] as? String,
                        fetchedAt: Date()
                    )
                    DispatchQueue.main.async { completion(profile) }
                } else {
                    DispatchQueue.main.async { completion(nil) }
                }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }.resume()
    }

    // MARK: - POST /api/auth/desktop-refresh

    func refreshToken(completion: @escaping (String?) -> Void) {
        guard let url = URL(string: "\(baseURL)/api/auth/desktop-refresh") else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("0", forHTTPHeaderField: "Content-Length")
        request.setValue(SessionManager.shared.cookieHeader, forHTTPHeaderField: "Cookie")

        URLSession.shared.dataTask(with: request) { data, response, error in
            guard let data, error == nil,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let success = json["success"] as? Bool, success,
                   let newToken = json["sessionToken"] as? String {
                    DispatchQueue.main.async { completion(newToken) }
                } else {
                    DispatchQueue.main.async { completion(nil) }
                }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }.resume()
    }

    // MARK: - GET /api/user/settings

    func fetchUserSettings(completion: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: "\(baseURL)/api/user/settings") else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.setValue(SessionManager.shared.cookieHeader, forHTTPHeaderField: "Cookie")

        URLSession.shared.dataTask(with: request) { data, response, error in
            guard let data, error == nil,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            do {
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                DispatchQueue.main.async { completion(json) }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }.resume()
    }

    // MARK: - GET /api/user/usage

    func fetchUsage(completion: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: "\(baseURL)/api/user/usage") else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.setValue(SessionManager.shared.cookieHeader, forHTTPHeaderField: "Cookie")
        request.setValue("macos", forHTTPHeaderField: "X-Client-Platform")

        URLSession.shared.dataTask(with: request) { data, response, error in
            guard let data, error == nil,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            do {
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                DispatchQueue.main.async { completion(json) }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }.resume()
    }

    // MARK: - POST /api/auth/desktop-login

    func login(email: String, password: String, completion: @escaping (Result<String, Error>) -> Void) {
        guard let url = URL(string: "\(baseURL)/api/auth/desktop-login") else {
            completion(.failure(AuthError.invalidURL))
            return
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: String] = ["email": email, "password": password]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                DispatchQueue.main.async { completion(.failure(error)) }
                return
            }
            guard let data, let http = response as? HTTPURLResponse else {
                DispatchQueue.main.async { completion(.failure(AuthError.noResponse)) }
                return
            }
            if http.statusCode == 401 {
                DispatchQueue.main.async { completion(.failure(AuthError.invalidCredentials)) }
                return
            }
            guard http.statusCode == 200 else {
                DispatchQueue.main.async { completion(.failure(AuthError.serverError(http.statusCode))) }
                return
            }
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let token = json["sessionToken"] as? String {
                    DispatchQueue.main.async { completion(.success(token)) }
                } else {
                    DispatchQueue.main.async { completion(.failure(AuthError.noToken)) }
                }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }.resume()
    }

    enum AuthError: LocalizedError {
        case invalidURL
        case noResponse
        case invalidCredentials
        case serverError(Int)
        case noToken

        var errorDescription: String? {
            switch self {
            case .invalidURL: return "Invalid API URL"
            case .noResponse: return "No response from server"
            case .invalidCredentials: return "Invalid email or password"
            case .serverError(let code): return "Server error (\(code))"
            case .noToken: return "No token in response"
            }
        }
    }
}
