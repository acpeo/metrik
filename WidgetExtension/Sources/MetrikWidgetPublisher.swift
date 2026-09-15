import Foundation

@main
enum MetrikWidgetPublisher {
    static func main() {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard !data.isEmpty else {
            FileHandle.standardError.write(Data("Widget snapshot input is empty\n".utf8))
            exit(3)
        }

        // publisher 嵌入了 widget extension 的 bundle identity（app.metrik.desktop.widget），
        // 所以它的 UserDefaults.standard 解析进 widget 的 sandbox container——和 widget
        // extension 自己的 UserDefaults.standard 是同一个 preferences plist。这是 ad-hoc
        // 签名（无 Team ID）下最可靠的共享方式：App Group 在没有 Team ID 时会被系统
        // 静默忽略，而 bundle-identity 共享不依赖它。
        let sharedDefaults = UserDefaults.standard
        sharedDefaults.set(data, forKey: "widgetSnapshotJSON")
        sharedDefaults.synchronize()

        let preferences = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("Library/Preferences", isDirectory: true)
            .appendingPathComponent("app.metrik.desktop.widget.plist", isDirectory: false)
        FileHandle.standardOutput.write(Data("\(preferences.path)\n".utf8))
    }
}
