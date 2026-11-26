import SwiftUI

@main
struct PomoApp: App {
    @StateObject private var ble = PomoBLE()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(ble)
                .preferredColorScheme(.dark)
        }
    }
}
