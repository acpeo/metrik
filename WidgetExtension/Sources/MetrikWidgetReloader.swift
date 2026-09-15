import Foundation
import WidgetKit

@main
enum MetrikWidgetReloader {
    static func main() {
        // 精确刷新本 bundle 下的两种组件。helper 内嵌宿主 App 的 bundle id，
        // 让 WidgetCenter 把请求归到 Metrik，而不是一个无归属的裸可执行文件。
        WidgetCenter.shared.reloadTimelines(ofKind: "MetrikFocusWidget")
        WidgetCenter.shared.reloadTimelines(ofKind: "MetrikOverviewWidget")

        // WidgetCenter 通过异步 XPC 发送请求。独立 helper 若在调用后立即退出，
        // 连接可能只完成 activate，消息还没交给 chronod 就被进程销毁。
        // 短暂运行主 RunLoop，确保请求实际入队；不等待 timeline 渲染完成。
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
}
