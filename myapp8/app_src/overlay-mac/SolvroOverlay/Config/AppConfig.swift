import Foundation

final class AppConfig {

    static let shared = AppConfig()

    private let defaults = UserDefaults.standard
    private let prefix = "com.solvro.overlay."

    private init() {}

    var windowOpacity: CGFloat {
        get {
            let val = defaults.double(forKey: prefix + "windowOpacity")
            return val > 0 ? CGFloat(val) : 1.0
        }
        set { defaults.set(Double(newValue), forKey: prefix + "windowOpacity") }
    }

    var windowX: CGFloat {
        get { CGFloat(defaults.double(forKey: prefix + "windowX")) }
        set { defaults.set(Double(newValue), forKey: prefix + "windowX") }
    }

    var windowY: CGFloat {
        get { CGFloat(defaults.double(forKey: prefix + "windowY")) }
        set { defaults.set(Double(newValue), forKey: prefix + "windowY") }
    }

    var windowWidth: CGFloat {
        get {
            let val = defaults.double(forKey: prefix + "windowWidth")
            return val > 0 ? CGFloat(val) : 800
        }
        set { defaults.set(Double(newValue), forKey: prefix + "windowWidth") }
    }

    var selectedModelIndex: Int {
        get { defaults.integer(forKey: prefix + "selectedModelIndex") }
        set { defaults.set(newValue, forKey: prefix + "selectedModelIndex") }
    }

    var selectedLanguageIndex: Int {
        get { defaults.integer(forKey: prefix + "selectedLanguageIndex") }
        set { defaults.set(newValue, forKey: prefix + "selectedLanguageIndex") }
    }

    var configRefreshInterval: TimeInterval { 900 }
}
