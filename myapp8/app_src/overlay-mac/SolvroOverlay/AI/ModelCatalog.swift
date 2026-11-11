import Foundation

struct SolvroModel {
    let id: String
    let displayName: String
    let tier: Int // 0=Free, 1=Pro, 2=Pro+
}

struct SolvroLanguage {
    let id: String
    let displayName: String
}

final class ModelCatalog {

    static let shared = ModelCatalog()

    private(set) var models: [SolvroModel] = []
    private(set) var languages: [SolvroLanguage] = []
    private(set) var selectedModelIndex: Int = 0
    private(set) var selectedLanguageIndex: Int = 0

    private init() {
        initDefaults()
    }

    private func initDefaults() {
        models = [
            SolvroModel(id: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", tier: 0),
            SolvroModel(id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro", tier: 1),
            SolvroModel(id: "claude-sonnet-5", displayName: "Claude Sonnet 5", tier: 2),
            SolvroModel(id: "claude-opus-4-8", displayName: "Claude Opus 4.8", tier: 2),
            SolvroModel(id: "claude-fable-5", displayName: "Claude Fable 5", tier: 2),
        ]
        languages = [
            SolvroLanguage(id: "cpp", displayName: "C++"),
            SolvroLanguage(id: "java", displayName: "Java"),
            SolvroLanguage(id: "python", displayName: "Python"),
            SolvroLanguage(id: "javascript", displayName: "JavaScript"),
            SolvroLanguage(id: "csharp", displayName: "C#"),
            SolvroLanguage(id: "typescript", displayName: "TypeScript"),
            SolvroLanguage(id: "go", displayName: "Go"),
            SolvroLanguage(id: "rust", displayName: "Rust"),
            SolvroLanguage(id: "ruby", displayName: "Ruby"),
            SolvroLanguage(id: "php", displayName: "PHP"),
            SolvroLanguage(id: "mysql", displayName: "MySQL"),
            SolvroLanguage(id: "postgresql", displayName: "PostgreSQL"),
            SolvroLanguage(id: "oracle", displayName: "Oracle"),
            SolvroLanguage(id: "bash", displayName: "Bash"),
        ]
        selectedModelIndex = 0
        selectedLanguageIndex = 0
    }

    var currentModel: SolvroModel? {
        guard selectedModelIndex < models.count else { return nil }
        return models[selectedModelIndex]
    }

    var currentLanguage: SolvroLanguage {
        guard selectedLanguageIndex < languages.count else {
            return SolvroLanguage(id: "cpp", displayName: "C++")
        }
        return languages[selectedLanguageIndex]
    }

    func cycleModel() {
        guard !models.isEmpty else { return }
        let userTier = SessionManager.shared.userTier
        var next = (selectedModelIndex + 1) % models.count
        let start = next
        while models[next].tier > userTier {
            next = (next + 1) % models.count
            if next == start { return }
        }
        if models[next].tier <= userTier {
            selectedModelIndex = next
            NSLog("[ModelCatalog] model: %@", models[next].displayName)
        }
    }

    func cycleLanguage() {
        guard !languages.isEmpty else { return }
        selectedLanguageIndex = (selectedLanguageIndex + 1) % languages.count
        NSLog("[ModelCatalog] language: %@", currentLanguage.displayName)
    }

    func updateModels(from json: [[String: Any]]) {
        var newModels: [SolvroModel] = []
        for item in json {
            guard let id = item["id"] as? String,
                  let name = item["name"] as? String else { continue }
            let tier = item["tier"] as? Int ?? 0
            newModels.append(SolvroModel(id: id, displayName: name, tier: tier))
        }
        if !newModels.isEmpty {
            models = newModels
            if selectedModelIndex >= models.count { selectedModelIndex = 0 }
            NSLog("[ModelCatalog] updated %d models from server", models.count)
        }
    }
}
